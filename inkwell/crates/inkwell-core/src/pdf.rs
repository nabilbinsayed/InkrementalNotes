//! PDF-native writer: three layers in one standard file, appended incrementally.
//!
//!   Layer 1  visual  -- variable-width ribbons as FILLED vector paths
//!   Layer 2  interop -- /Ink annotations carrying /AP appearance streams
//!   Layer 3  data    -- the compressed sidecar, embedded, under private keys
//!
//! Saving uses PDF incremental update: changed objects, a new xref section, and
//! a trailer whose /Prev chains to the previous one. Append-only, so the bytes
//! already on disk are never rewritten -- which is what makes autosave both fast
//! and crash-safe. A torn tail leaves the previous xref valid; recovery is
//! `truncate to the last %%EOF`.

use std::collections::BTreeMap;
use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};

use crate::doc::{self, Document};
use crate::ink::{ribbon_path, PathCmd, Stroke, ToolKind};
use crate::pdfobj::{self as po, Error, Result};

/// Number of strokes sharing one `/Ink` annotation. One annotation per stroke is
/// spec-correct but a dense page then carries thousands of annotations, which
/// makes Acrobat crawl. Grouping keeps interop without the pathology.
pub const DEFAULT_GROUP: usize = 64;

pub struct PdfFile {
    base: Vec<u8>,
    next_id: u32,
    root_num: u32,
    trailer_id: Option<Vec<u8>>,
    prev_xref: usize,
    pages: Vec<u32>,
    new_objs: BTreeMap<u32, Vec<u8>>,
}

impl PdfFile {
    pub fn open(bytes: Vec<u8>) -> Result<Self> {
        let d = &bytes;
        let prev_xref = po::last_startxref(d)?;

        // Reject xref-stream PDFs loudly instead of corrupting them.
        let at = po::skip_ws(d, prev_xref);
        if d.get(at..at + 4) != Some(b"xref") {
            return Err(Error::XrefStream);
        }

        let tr = po::last_trailer_dict(d)?;
        let root_num = po::dict_get(d, tr, "/Root")
            .and_then(|r| po::as_ref_num(d, r))
            .ok_or(Error::NoRoot)?;
        let size = po::dict_get(d, tr, "/Size")
            .and_then(|r| po::as_int(d, r))
            .ok_or(Error::NoSize)?;
        let trailer_id =
            po::dict_get(d, tr, "/ID").map(|r| d[r.0..r.1].to_vec());

        let mut f = Self {
            base: bytes,
            next_id: size as u32,
            root_num,
            trailer_id,
            prev_xref,
            pages: Vec::new(),
            new_objs: BTreeMap::new(),
        };
        f.pages = f.collect_pages()?;
        Ok(f)
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    // -- structure walk ----------------------------------------------------

    fn obj_dict(&self, num: u32) -> Result<(usize, usize)> {
        let (bs, _) = po::find_object(&self.base, num).ok_or(Error::MissingObject(num))?;
        po::dict_inner(&self.base, bs)
    }

    fn collect_pages(&self) -> Result<Vec<u32>> {
        let cat = self.obj_dict(self.root_num)?;
        let pages_ref = po::dict_get(&self.base, cat, "/Pages")
            .and_then(|r| po::as_ref_num(&self.base, r))
            .ok_or(Error::Malformed("catalog has no /Pages"))?;
        let mut out = Vec::new();
        self.walk_pages(pages_ref, &mut out, 0)?;
        Ok(out)
    }

    fn walk_pages(&self, node: u32, out: &mut Vec<u32>, depth: u32) -> Result<()> {
        if depth > 32 {
            return Err(Error::Malformed("page tree too deep / cyclic"));
        }
        let dict = self.obj_dict(node)?;
        let ty = po::dict_get(&self.base, dict, "/Type")
            .map(|r| self.base[r.0..r.1].to_vec())
            .unwrap_or_default();
        if ty == b"/Page" {
            out.push(node);
            return Ok(());
        }
        if let Some(kids) = po::dict_get(&self.base, dict, "/Kids") {
            for k in refs_in_array(&self.base, kids) {
                self.walk_pages(k, out, depth + 1)?;
            }
        }
        Ok(())
    }

    // -- object emission ---------------------------------------------------

    fn add(&mut self, body: Vec<u8>) -> u32 {
        let n = self.next_id;
        self.next_id += 1;
        self.new_objs.insert(n, body);
        n
    }

    fn replace(&mut self, num: u32, body: Vec<u8>) {
        self.new_objs.insert(num, body);
    }

    fn add_stream(&mut self, dict_extra: &str, data: &[u8], compress: bool) -> u32 {
        let (payload, filter) = if compress {
            let mut e = ZlibEncoder::new(Vec::new(), Compression::best());
            e.write_all(data).expect("in-memory write");
            (e.finish().expect("in-memory finish"), " /Filter /FlateDecode")
        } else {
            (data.to_vec(), "")
        };
        let head = format!("<< {dict_extra}{filter} /Length {} >>\nstream\n", payload.len());
        let mut body = head.into_bytes();
        body.extend_from_slice(&payload);
        body.extend_from_slice(b"\nendstream");
        self.add(body)
    }

    fn resolve_rectangle(&self, r: (usize, usize)) -> Option<[f64; 4]> {
        let raw = if let Some(ref_num) = po::as_ref_num(&self.base, r) {
            let (obj_start, _) = po::find_object(&self.base, ref_num)?;
            let end = po::skip_value(&self.base, obj_start);
            &self.base[obj_start..end]
        } else {
            &self.base[r.0..r.1]
        };

        let s = String::from_utf8_lossy(raw);
        let nums: Vec<f64> = s
            .trim_matches(|c| c == '[' || c == ']')
            .split_whitespace()
            .filter_map(|t| t.parse::<f64>().ok())
            .collect();
        if nums.len() == 4 {
            Some([nums[0], nums[1], nums[2], nums[3]])
        } else {
            None
        }
    }

    pub fn page_box(&self, page_num: u32) -> [f64; 4] {
        let mut cur_obj = page_num;
        let mut depth = 0;

        while depth < 32 {
            if let Ok(dict) = self.obj_dict(cur_obj) {
                // Check CropBox first, then MediaBox
                let box_ref = po::dict_get(&self.base, dict, "/CropBox")
                    .or_else(|| po::dict_get(&self.base, dict, "/MediaBox"));

                if let Some(r) = box_ref {
                    if let Some(nums) = self.resolve_rectangle(r) {
                        let (llx, urx) = if nums[0] <= nums[2] { (nums[0], nums[2]) } else { (nums[2], nums[0]) };
                        let (lly, ury) = if nums[1] <= nums[3] { (nums[1], nums[3]) } else { (nums[3], nums[1]) };
                        return [llx, lly, urx, ury];
                    }
                }

                // If not found on this node, follow /Parent up the page tree
                if let Some(parent_ref) = po::dict_get(&self.base, dict, "/Parent") {
                    if let Some(parent_num) = po::as_ref_num(&self.base, parent_ref) {
                        cur_obj = parent_num;
                        depth += 1;
                        continue;
                    }
                }
            }
            break;
        }

        [0.0, 0.0, 595.0, 842.0]
    }

    pub fn page_height(&self, page_num: u32) -> f64 {
        let b = self.page_box(page_num);
        (b[3] - b[1]).abs()
    }

    // -- the interesting part ---------------------------------------------

    /// Write `doc` into the file as a new incremental generation.
    pub fn write_document(&mut self, document: &Document, group: usize) -> Result<()> {
        self.write_document_with_boxes(document, group, None)
    }

    /// Write `doc` into the file with optional authoritative explicit page boxes.
    pub fn write_document_with_boxes(
        &mut self,
        document: &Document,
        group: usize,
        explicit_boxes: Option<&std::collections::HashMap<usize, [f64; 4]>>,
    ) -> Result<()> {
        let group = group.max(1);
        let sidecar_raw = doc::encode_sidecar(document);
        let hash = Sha256::digest(&sidecar_raw);

        // ---- Layer 1 + 2, per sheet ------------------------------------
        for (sheet_idx, sheet) in document.sheets.iter().enumerate() {
            let (page_num, pdf_page_idx) = match sheet.kind {
                doc::SheetKind::BoundedPage { source_pdf_page } => {
                    match self.pages.get(source_pdf_page) {
                        Some(n) => (*n, source_pdf_page),
                        None => continue,
                    }
                }
                // FreeCanvas materialisation is M7; skip cleanly rather than
                // silently dropping ink into the void.
                doc::SheetKind::FreeCanvas => continue,
            };
            let _ = sheet_idx;

            let pbox = if let Some(boxes) = explicit_boxes {
                boxes.get(&pdf_page_idx).copied().or_else(|| boxes.get(&sheet_idx).copied()).unwrap_or_else(|| self.page_box(page_num))
            } else {
                self.page_box(page_num)
            };

            let strokes: Vec<&Stroke> = sheet.strokes().collect();
            let mut annots = Vec::new();
            for chunk in strokes.chunks(group) {
                if let Some(a) = self.emit_group(chunk, pbox) {
                    annots.push(a);
                }
            }
            self.rewrite_page(page_num, &annots)?;
        }

        // ---- Layer 3 ----------------------------------------------------
        let ef = self.add_stream(
            &format!(
                "/Type /EmbeddedFile /Subtype /application#2Fx-inkwell \
                 /Params << /Size {} >>",
                sidecar_raw.len()
            ),
            &sidecar_raw,
            true,
        );
        let fs = self.add(
            format!(
                "<< /Type /Filespec /F (inkwell.doc) /UF (inkwell.doc) \
                 /Desc (Inkwell editable ink data \\(pressure, layers, samples\\)) \
                 /AFRelationship /Supplement /EF << /F {ef} 0 R >> >>"
            )
            .into_bytes(),
        );
        self.rewrite_catalog(ef, fs, &hash)?;
        Ok(())
    }

    /// One `/Ink` annotation covering `strokes`, with an `/AP` appearance stream
    /// holding their filled ribbons.
    fn emit_group(&mut self, strokes: &[&Stroke], page_box: [f64; 4]) -> Option<u32> {
        let llx = page_box[0];
        let lly = page_box[1];
        let urx = page_box[2];
        let ury = page_box[3];

        if strokes.is_empty() {
            return None;
        }

        let page_rect = [llx, lly, urx, ury];

        // appearance content: one fill per stroke
        let mut content = Vec::new();
        let mut needs_multiply = false;
        for s in strokes {
            let simplified_stroke;
            let s_ref = if s.samples.len() > 3 {
                simplified_stroke = Stroke {
                    id: s.id,
                    kind: s.kind,
                    rgb: s.rgb,
                    brush: s.brush,
                    samples: crate::ink::simplify(&s.samples, 0.4),
                };
                &simplified_stroke
            } else {
                *s
            };

            let path = ribbon_path(s_ref, 16);
            if path.len() < 3 {
                continue;
            }
            let gs = match s_ref.kind {
                ToolKind::Highlighter => {
                    needs_multiply = true;
                    "/GSm"
                }
                ToolKind::Pen => "/GSn",
            };
            let _ = write!(
                content,
                "q\n{gs} gs\n{:.3} {:.3} {:.3} rg\n",
                s_ref.rgb[0], s_ref.rgb[1], s_ref.rgb[2]
            );
            // Transform y_canvas -> y_pdf = ury - y_canvas, x_canvas -> x_pdf = llx + x_canvas
            for cmd in &path {
                match cmd {
                    PathCmd::MoveTo(p) => {
                        let _ = writeln!(content, "{} {} m", fmt_coord(llx + p.0), fmt_coord(ury - p.1));
                    }
                    PathCmd::LineTo(p) => {
                        let _ = writeln!(content, "{} {} l", fmt_coord(llx + p.0), fmt_coord(ury - p.1));
                    }
                    PathCmd::CurveTo(c) => {
                        let _ = writeln!(
                            content,
                            "{} {} {} {} {} {} c",
                            fmt_coord(llx + c[0].0),
                            fmt_coord(ury - c[0].1),
                            fmt_coord(llx + c[1].0),
                            fmt_coord(ury - c[1].1),
                            fmt_coord(llx + c[2].0),
                            fmt_coord(ury - c[2].1)
                        );
                    }
                    PathCmd::Close => {
                        let _ = writeln!(content, "h");
                    }
                }
            }
            let _ = write!(content, "f\nQ\n");
        }
        if content.is_empty() {
            return None;
        }

        let mut gstates = String::from("/GSn << /Type /ExtGState /BM /Normal /ca 1 >>");
        if needs_multiply {
            gstates.push_str(" /GSm << /Type /ExtGState /BM /Multiply /ca 0.42 >>");
        }
        let ap = self.add_stream(
            &format!(
                "/Type /XObject /Subtype /Form /BBox [{}] /Resources << /ExtGState << {gstates} >> >>",
                fmt_rect(&page_rect)
            ),
            &content,
            true,
        );

        // /InkList: decimated centrelines converted to PDF user space (x_pdf = llx + x_canvas, y_pdf = ury - y_canvas)
        let mut inklist = String::new();
        for s in strokes {
            let simplified = if s.samples.len() > 3 {
                crate::ink::simplify(&s.samples, 0.5)
            } else {
                s.samples.clone()
            };
            let centreline: Vec<(f64, f64)> = simplified.iter().step_by(2).map(|sm| (sm.x, sm.y)).collect();
            inklist.push('[');
            for (x, y) in centreline {
                let x_pdf = llx + x;
                let y_pdf = ury - y;
                inklist.push_str(&fmt_coord(x_pdf));
                inklist.push(' ');
                inklist.push_str(&fmt_coord(y_pdf));
                inklist.push(' ');
            }
            if inklist.ends_with(' ') {
                inklist.pop();
            }
            inklist.push(']');
        }
        let head = strokes[0];
        let annot = self.add(
            format!(
                "<< /Type /Annot /Subtype /Ink /F 4 /Rect [{}] \
                 /InkList [{inklist}] /C [{:.3} {:.3} {:.3}] \
                 /BS << /W {:.2} /S /S >> /T (Inkwell) /NM ({}) \
                 /AP << /N {ap} 0 R >> /Inkw_Sid ({}) /Inkw_N {} >>",
                fmt_rect(&page_rect),
                head.rgb[0],
                head.rgb[1],
                head.rgb[2],
                head.brush.base_width,
                head.id_hex(),
                head.id_hex(),
                strokes.len(),
            )
            .into_bytes(),
        );
        Some(annot)
    }

    /// Replace the page's `/Annots`, dropping our own from the previous
    /// generation but preserving anyone else's (Acrobat comments, form fields).
    fn rewrite_page(&mut self, page_num: u32, annots: &[u32]) -> Result<()> {
        let dict = self.obj_dict(page_num)?;
        let mut kept: Vec<u32> = Vec::new();
        if let Some(r) = po::dict_get(&self.base, dict, "/Annots") {
            for n in refs_in_array(&self.base, r) {
                let is_ours = self
                    .obj_dict(n)
                    .ok()
                    .map(|d| po::dict_get(&self.base, d, "/Inkw_Sid").is_some())
                    .unwrap_or(false);
                if !is_ours {
                    kept.push(n);
                }
            }
        }
        let mut body = b"<< ".to_vec();
        body.extend_from_slice(&po::dict_without(&self.base, dict, &["/Annots"]));
        body.extend_from_slice(b"/Annots [");
        for n in kept.iter().chain(annots.iter()) {
            body.extend_from_slice(format!("{n} 0 R ").as_bytes());
        }
        body.extend_from_slice(b"] >>");
        self.replace(page_num, body);
        Ok(())
    }

    fn rewrite_catalog(&mut self, ef: u32, fs: u32, hash: &[u8]) -> Result<()> {
        let dict = self.obj_dict(self.root_num)?;
        let mut body = b"<< ".to_vec();
        body.extend_from_slice(&po::dict_without(
            &self.base,
            dict,
            &["/Names", "/AF", "/Inkw_Doc", "/Inkw_Ver", "/Inkw_Hash"],
        ));
        body.extend_from_slice(
            format!(
                "/Names << /EmbeddedFiles << /Names [(inkwell.doc) {fs} 0 R] >> >>\n\
                 /AF [{fs} 0 R]\n\
                 /Inkw_Doc {ef} 0 R\n\
                 /Inkw_Ver 1\n\
                 /Inkw_Hash <{}>\n>>",
                hex(hash)
            )
            .as_bytes(),
        );
        let n = self.root_num;
        self.replace(n, body);
        Ok(())
    }

    /// Serialise the appended generation. The prefix is byte-identical to the
    /// input, always.
    pub fn finish(self) -> Vec<u8> {
        let mut buf = self.base;
        if !buf.ends_with(b"\n") {
            buf.push(b'\n');
        }
        let mut offsets: BTreeMap<u32, usize> = BTreeMap::new();
        for (num, body) in &self.new_objs {
            offsets.insert(*num, buf.len());
            buf.extend_from_slice(format!("{num} 0 obj\n").as_bytes());
            buf.extend_from_slice(body);
            buf.extend_from_slice(b"\nendobj\n");
        }
        let xref_off = buf.len();
        buf.extend_from_slice(b"xref\n0 1\n0000000000 65535 f \n");
        // one subsection per object: valid, and avoids run-length bookkeeping
        for (num, off) in &offsets {
            buf.extend_from_slice(format!("{num} 1\n{off:010} 00000 n \n").as_bytes());
        }
        buf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root {} 0 R /Prev {}",
                self.next_id, self.root_num, self.prev_xref
            )
            .as_bytes(),
        );
        if let Some(id) = &self.trailer_id {
            buf.extend_from_slice(b" /ID ");
            buf.extend_from_slice(id);
        }
        buf.extend_from_slice(format!(" >>\nstartxref\n{xref_off}\n%%EOF\n").as_bytes());
        buf
    }
}

// ---------------------------------------------------------------------------
// reading the sidecar back
// ---------------------------------------------------------------------------

/// Extract and verify the embedded editable data.
pub enum SidecarStatus {
    /// Full-fidelity data recovered.
    Ok(Document),
    /// No Inkwell data in this file (a plain PDF, or one saved by another app
    /// that dropped the embedded file). Fall back to `/InkList` reconstruction.
    Absent,
    /// Present but unusable. Never a hard failure: warn and fall back.
    Corrupt(String),
    /// Present and parsed, but the visual layer has since been changed by
    /// another application, so the two layers disagree.
    Stale(Document),
}

pub fn read_sidecar(bytes: &[u8]) -> Result<SidecarStatus> {
    let d = bytes;
    let tr = po::last_trailer_dict(d)?;
    let root = po::dict_get(d, tr, "/Root")
        .and_then(|r| po::as_ref_num(d, r))
        .ok_or(Error::NoRoot)?;
    let (bs, _) = po::find_object(d, root).ok_or(Error::MissingObject(root))?;
    let cat = po::dict_inner(d, bs)?;

    let ef = match po::dict_get(d, cat, "/Inkw_Doc").and_then(|r| po::as_ref_num(d, r)) {
        Some(n) => n,
        None => return Ok(SidecarStatus::Absent),
    };
    let raw = match read_stream(d, ef) {
        Ok(v) => v,
        Err(e) => return Ok(SidecarStatus::Corrupt(e.to_string())),
    };
    let declared = po::dict_get(d, cat, "/Inkw_Hash").map(|r| {
        String::from_utf8_lossy(&d[r.0..r.1]).trim().trim_matches(['<', '>']).to_ascii_lowercase()
    });
    let actual = hex(&Sha256::digest(&raw));

    match doc::decode_sidecar(&raw) {
        Ok(doc) => {
            if declared.as_deref().is_some_and(|h| h != actual) {
                Ok(SidecarStatus::Stale(doc))
            } else {
                Ok(SidecarStatus::Ok(doc))
            }
        }
        Err(e) => Ok(SidecarStatus::Corrupt(e.to_string())),
    }
}

/// Decode one stream object's data, honouring `/Filter /FlateDecode`.
pub fn read_stream(d: &[u8], num: u32) -> Result<Vec<u8>> {
    let (bs, be) = po::find_object(d, num).ok_or(Error::MissingObject(num))?;
    let dict = po::dict_inner(d, bs)?;
    let sk = po::find(&d[bs..be], b"stream", 0)
        .map(|p| bs + p)
        .ok_or(Error::Malformed("object is not a stream"))?;
    let mut ds = sk + 6;
    if d.get(ds) == Some(&b'\r') {
        ds += 1;
    }
    if d.get(ds) == Some(&b'\n') {
        ds += 1;
    }
    let len = po::dict_get(d, dict, "/Length")
        .and_then(|r| po::as_int(d, r))
        .ok_or(Error::Malformed("stream has no /Length"))? as usize;
    let de = (ds + len).min(d.len());
    let raw = &d[ds..de];

    let flate = po::dict_get(d, dict, "/Filter")
        .map(|r| po::find(&d[r.0..r.1], b"FlateDecode", 0).is_some())
        .unwrap_or(false);
    if !flate {
        return Ok(raw.to_vec());
    }
    let mut out = Vec::new();
    let mut dec = flate2::write::ZlibDecoder::new(&mut out);
    dec.write_all(raw).map_err(Error::Io)?;
    dec.finish().map_err(Error::Io)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// crash recovery
// ---------------------------------------------------------------------------

/// Truncate a torn file back to its last complete generation.
///
/// This is the entire recovery routine, and it works because incremental
/// updates only ever append: every `%%EOF` in the file marks a point at which
/// the document was fully valid on disk.
pub fn recover_truncated(data: &[u8]) -> Option<&[u8]> {
    let p = po::rfind(data, b"%%EOF")?;
    let mut j = p + 5;
    while j < data.len() && (data[j] == b'\r' || data[j] == b'\n') {
        j += 1;
    }
    Some(&data[..j])
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn fmt_coord(v: f64) -> String {
    let rounded = (v * 100.0).round() / 100.0;
    if (rounded - rounded.round()).abs() < 1e-4 {
        format!("{}", rounded.round() as i64)
    } else {
        let s = format!("{:.2}", rounded);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn fmt_rect(b: &[f64; 4]) -> String {
    format!("{} {} {} {}", fmt_coord(b[0]), fmt_coord(b[1]), fmt_coord(b[2]), fmt_coord(b[3]))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Collect `N 0 R` object numbers appearing in an array value range.
fn refs_in_array(d: &[u8], range: (usize, usize)) -> Vec<u32> {
    let s = String::from_utf8_lossy(&d[range.0..range.1]);
    let toks: Vec<&str> = s
        .trim_matches(|c| c == '[' || c == ']')
        .split_whitespace()
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 < toks.len() + 1 {
        if i + 2 < toks.len() + 1 && toks.get(i + 2) == Some(&"R") {
            if let Ok(n) = toks[i].parse::<u32>() {
                out.push(n);
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    out
}
