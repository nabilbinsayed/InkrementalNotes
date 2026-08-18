//! Document model and the sidecar container.

use crate::codec;
use crate::ink::{Stroke, NOMINAL_HZ};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SheetKind {
    /// A page that came from the imported PDF. Bounded.
    BoundedPage { source_pdf_page: usize },
    /// An unbounded region. Materialised into real pages on save; the true
    /// unbounded coordinates live here so reopening is exact.
    FreeCanvas,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub name: String,
    pub visible: bool,
    #[serde(skip)]
    pub strokes: Vec<Stroke>,
}

impl Layer {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into(), visible: true, strokes: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sheet {
    pub kind: SheetKind,
    pub layers: Vec<Layer>,
}

impl Sheet {
    pub fn bounded(page: usize) -> Self {
        Self {
            kind: SheetKind::BoundedPage { source_pdf_page: page },
            layers: vec![Layer::new("Ink")],
        }
    }
    pub fn blank() -> Self {
        Self {
            kind: SheetKind::BoundedPage { source_pdf_page: usize::MAX },
            layers: vec![Layer::new("Ink")],
        }
    }
    pub fn strokes(&self) -> impl Iterator<Item = &Stroke> {
        self.layers.iter().flat_map(|l| l.strokes.iter())
    }
    pub fn stroke_count(&self) -> usize {
        self.layers.iter().map(|l| l.strokes.len()).sum()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub model: String,
    pub report_hz: f64,
    pub tilt: bool,
}

impl Default for DeviceInfo {
    fn default() -> Self {
        Self { model: "unknown".into(), report_hz: NOMINAL_HZ, tilt: false }
    }
}

/// A viewport is a window onto the document. Several may exist at once with
/// independent zoom and scroll -- this is what makes the split "PDF left, blank
/// page right" layout cheap. First-class from day one on purpose; retrofitting
/// it later is painful.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub sheet: usize,
    pub pan: (f64, f64),
    pub zoom: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self { sheet: 0, pan: (0.0, 0.0), zoom: 1.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Document {
    pub generation: u64,
    pub device: DeviceInfo,
    pub sheets: Vec<Sheet>,
    pub viewports: Vec<Viewport>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            generation: 0,
            device: DeviceInfo::default(),
            sheets: Vec::new(),
            viewports: vec![Viewport::default()],
        }
    }
}

impl Document {
    /// Create a document shadowing an imported PDF of `n` pages.
    pub fn for_pdf(n_pages: usize) -> Self {
        Self { sheets: (0..n_pages).map(Sheet::bounded).collect(), ..Default::default() }
    }

    pub fn insert_sheet(&mut self, index: usize) {
        let insert_at = index.min(self.sheets.len());
        self.sheets.insert(insert_at, Sheet::bounded(insert_at));
        self.reindex_bounded_sheets();
    }

    pub fn duplicate_sheet(&mut self, index: usize) -> Option<usize> {
        if index >= self.sheets.len() {
            return None;
        }
        let cloned = self.sheets[index].clone();
        let target_idx = index + 1;
        self.sheets.insert(target_idx, cloned);
        self.reindex_bounded_sheets();
        Some(target_idx)
    }

    pub fn delete_sheet(&mut self, index: usize) -> bool {
        if index >= self.sheets.len() || self.sheets.len() <= 1 {
            return false;
        }
        self.sheets.remove(index);
        self.reindex_bounded_sheets();
        true
    }

    pub fn reorder_sheet(&mut self, from: usize, to: usize) -> bool {
        if from >= self.sheets.len() || to >= self.sheets.len() {
            return false;
        }
        if from == to {
            return true;
        }
        let sheet = self.sheets.remove(from);
        self.sheets.insert(to, sheet);
        self.reindex_bounded_sheets();
        true
    }

    pub fn reindex_bounded_sheets(&mut self) {
        for (i, sheet) in self.sheets.iter_mut().enumerate() {
            if let SheetKind::BoundedPage { ref mut source_pdf_page } = sheet.kind {
                *source_pdf_page = i;
            }
        }
    }

    pub fn stroke_count(&self) -> usize {
        self.sheets.iter().map(|s| s.stroke_count()).sum()
    }

    pub fn sample_count(&self) -> usize {
        self.sheets.iter().flat_map(|s| s.strokes()).map(|s| s.samples.len()).sum()
    }

    pub fn push_stroke(&mut self, sheet: usize, stroke: Stroke) {
        while self.sheets.len() <= sheet {
            self.sheets.push(Sheet::bounded(self.sheets.len()));
        }
        if let Some(sh) = self.sheets.get_mut(sheet) {
            if sh.layers.is_empty() {
                sh.layers.push(Layer::new("Ink"));
            }
            sh.layers[0].strokes.push(stroke);
        }
    }


    /// Remove a stroke by id from anywhere in the document.
    pub fn remove_stroke(&mut self, id: u128) -> bool {
        for sh in &mut self.sheets {
            for l in &mut sh.layers {
                if let Some(i) = l.strokes.iter().position(|s| s.id == id) {
                    l.strokes.remove(i);
                    return true;
                }
            }
        }
        false
    }

    /// Erase all strokes on a given sheet whose centreline passes within
    /// `radius` (in PDF user-units) of point `(px, py)`.
    /// Returns the IDs of removed strokes.
    pub fn erase_strokes_near(&mut self, sheet: usize, px: f64, py: f64, radius: f64) -> Vec<u128> {
        let mut removed = Vec::new();
        let Some(sh) = self.sheets.get_mut(sheet) else { return removed };
        for layer in &mut sh.layers {
            layer.strokes.retain(|s| {
                let max_r = radius + s.brush.base_width * 0.5;
                if let Some(b) = s.bbox() {
                    if px + max_r < b[0] || px - max_r > b[2] || py + max_r < b[1] || py - max_r > b[3] {
                        return true;
                    }
                }
                let hit = s.samples.iter().any(|samp| {
                    let (sx, sy) = (samp.x, samp.y);
                    (sx - px).hypot(sy - py) < max_r
                });
                if hit { removed.push(s.id); }
                !hit
            });
        }
        removed
    }

    /// Erase all strokes on a given sheet whose bounding box intersects the
    /// axis-aligned rectangle `[x0, y0, x1, y1]` (PDF user-units).
    /// Returns the IDs of removed strokes.
    pub fn erase_strokes_in_rect(&mut self, sheet: usize, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<u128> {
        let mut removed = Vec::new();
        let (rx0, rx1) = if x0 < x1 { (x0, x1) } else { (x1, x0) };
        let (ry0, ry1) = if y0 < y1 { (y0, y1) } else { (y1, y0) };
        let Some(sh) = self.sheets.get_mut(sheet) else { return removed };
        for layer in &mut sh.layers {
            layer.strokes.retain(|s| {
                if let Some(b) = s.bbox() {
                    if rx1 < b[0] || rx0 > b[2] || ry1 < b[1] || ry0 > b[3] {
                        return true;
                    }
                }
                let hit = s.samples.iter().any(|samp| {
                    samp.x >= rx0 && samp.x <= rx1 && samp.y >= ry0 && samp.y <= ry1
                });
                if hit { removed.push(s.id); }
                !hit
            });
        }
        removed
    }
}

// ---------------------------------------------------------------------------
// Sidecar container
// ---------------------------------------------------------------------------
//
//   magic  "IWDC"
//   u8     version
//   u32LE  json length
//   ..     JSON document skeleton (structure, no sample data)
//   ..     binary stroke payload (codec.rs), strokes in sheet/layer order

pub const SIDECAR_MAGIC: &[u8; 4] = b"IWDC";
pub const SIDECAR_VERSION: u8 = 1;

#[derive(Debug)]
pub enum SidecarError {
    BadMagic,
    UnsupportedVersion(u8),
    Truncated,
    Json(String),
    Codec(codec::CodecError),
    StrokeCountMismatch { expected: usize, found: usize },
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SidecarError::BadMagic => write!(f, "not an Inkwell sidecar"),
            SidecarError::UnsupportedVersion(v) => write!(f, "sidecar version {v} is newer than this build; open read-only"),
            SidecarError::Truncated => write!(f, "sidecar truncated"),
            SidecarError::Json(e) => write!(f, "sidecar json: {e}"),
            SidecarError::Codec(e) => write!(f, "sidecar payload: {e}"),
            SidecarError::StrokeCountMismatch { expected, found } => {
                write!(f, "skeleton expects {expected} strokes, payload has {found}")
            }
        }
    }
}

impl std::error::Error for SidecarError {}

pub fn encode_sidecar(doc: &Document) -> Vec<u8> {
    let strokes: Vec<Stroke> = doc.sheets.iter().flat_map(|s| s.strokes().cloned()).collect();
    // Layer::strokes is #[serde(skip)], so the JSON carries structure only and
    // all bulk sample data goes through the compact codec.
    let mut counts = Vec::new();
    for sh in &doc.sheets {
        counts.push(sh.layers.iter().map(|l| l.strokes.len()).collect::<Vec<_>>());
    }
    let skeleton = serde_json::json!({
        "generation": doc.generation,
        "device": doc.device,
        "sheets": doc.sheets,
        "viewports": doc.viewports,
        "layer_stroke_counts": counts,
    });
    let json = serde_json::to_vec(&skeleton).expect("skeleton is serialisable");
    let payload = codec::encode(&strokes);

    let mut out = Vec::with_capacity(9 + json.len() + payload.len());
    out.extend_from_slice(SIDECAR_MAGIC);
    out.push(SIDECAR_VERSION);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(&payload);
    out
}

pub fn decode_sidecar(buf: &[u8]) -> std::result::Result<Document, SidecarError> {
    if buf.len() < 9 || &buf[0..4] != SIDECAR_MAGIC {
        return Err(SidecarError::BadMagic);
    }
    if buf[4] != SIDECAR_VERSION {
        return Err(SidecarError::UnsupportedVersion(buf[4]));
    }
    let jlen = u32::from_le_bytes([buf[5], buf[6], buf[7], buf[8]]) as usize;
    let jend = 9 + jlen;
    if buf.len() < jend {
        return Err(SidecarError::Truncated);
    }
    let sk: serde_json::Value =
        serde_json::from_slice(&buf[9..jend]).map_err(|e| SidecarError::Json(e.to_string()))?;
    let strokes = codec::decode(&buf[jend..]).map_err(SidecarError::Codec)?;

    let mut doc = Document {
        generation: sk["generation"].as_u64().unwrap_or(0),
        device: serde_json::from_value(sk["device"].clone()).unwrap_or_default(),
        sheets: serde_json::from_value(sk["sheets"].clone())
            .map_err(|e| SidecarError::Json(e.to_string()))?,
        viewports: serde_json::from_value(sk["viewports"].clone())
            .unwrap_or_else(|_| vec![Viewport::default()]),
    };

    let counts: Vec<Vec<usize>> =
        serde_json::from_value(sk["layer_stroke_counts"].clone()).unwrap_or_default();
    let total: usize = counts.iter().flatten().sum();
    if total != strokes.len() {
        return Err(SidecarError::StrokeCountMismatch { expected: total, found: strokes.len() });
    }

    // redistribute the flat payload back into sheets/layers
    let mut it = strokes.into_iter();
    for (si, sheet) in doc.sheets.iter_mut().enumerate() {
        for (li, layer) in sheet.layers.iter_mut().enumerate() {
            let n = counts.get(si).and_then(|c| c.get(li)).copied().unwrap_or(0);
            layer.strokes = it.by_ref().take(n).collect();
        }
    }
    Ok(doc)
}
