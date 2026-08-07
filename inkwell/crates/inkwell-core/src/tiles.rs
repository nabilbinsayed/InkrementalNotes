//! Tile cache for the PDF underlay.
//!
//! The rule that makes PDF underlays crisp (requirement 7) is: **never
//! rasterise at import**. Rasterising once at a fixed DPI is exactly what makes
//! imported PDFs pixelate when you zoom in, and it is the specific defect that
//! ruins several popular note apps. Instead the page is re-rasterised on demand,
//! per zoom level, in tiles, on a background thread pool.
//!
//! The rasteriser itself (PDFium) is deliberately behind a trait. All the logic
//! that is actually easy to get wrong -- level-of-detail selection, which tiles
//! are visible, eviction under a memory budget, and what to draw during the gap
//! before a sharp tile arrives -- lives here, in pure Rust, and is tested with a
//! stub. Wiring PDFium in is then mechanical.

use std::collections::HashMap;

/// Tile edge length in device pixels.
pub const TILE: u32 = 512;
/// LOD is clamped to this range: 2^-3 (1/8x) .. 2^5 (32x).
pub const LOD_MIN: i8 = -3;
pub const LOD_MAX: i8 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TileKey {
    pub page: u32,
    /// Power-of-two zoom bucket. `scale = 2^lod`.
    pub lod: i8,
    pub tx: i32,
    pub ty: i32,
}

#[derive(Debug, Clone)]
pub struct Tile {
    pub w: u32,
    pub h: u32,
    /// RGB8.
    pub data: Vec<u8>,
}

impl Tile {
    pub fn bytes(&self) -> usize {
        self.data.len()
    }
}

/// A viewport in PDF point space, plus the device pixel ratio.
#[derive(Debug, Clone, Copy)]
pub struct View {
    pub page: u32,
    /// Top-left of the visible region, in points.
    pub origin: (f64, f64),
    /// Visible size in points.
    pub size: (f64, f64),
    pub zoom: f64,
    pub dpr: f64,
}

impl View {
    /// Device scale actually needed to render crisply.
    pub fn device_scale(&self) -> f64 {
        self.zoom * self.dpr
    }

    /// Pick the power-of-two bucket at or above the required scale, so tiles are
    /// downscaled rather than upscaled (upscaling looks soft; downscaling does
    /// not). Clamped to the supported range.
    pub fn lod(&self) -> i8 {
        let s = self.device_scale().max(1e-6);
        (s.log2().ceil() as i32).clamp(LOD_MIN as i32, LOD_MAX as i32) as i8
    }
}

pub fn lod_scale(lod: i8) -> f64 {
    2f64.powi(lod as i32)
}

/// Tiles intersecting the viewport, in a spiral-ish order so the centre of the
/// screen fills in first.
pub fn visible_tiles(v: &View) -> Vec<TileKey> {
    let lod = v.lod();
    let s = lod_scale(lod);
    let t = TILE as f64 / s; // tile edge in points at this lod

    let x0 = (v.origin.0 / t).floor() as i32;
    let y0 = (v.origin.1 / t).floor() as i32;
    let x1 = ((v.origin.0 + v.size.0) / t).ceil() as i32;
    let y1 = ((v.origin.1 + v.size.1) / t).ceil() as i32;

    let cx = (x0 + x1) as f64 / 2.0;
    let cy = (y0 + y1) as f64 / 2.0;

    let mut out = Vec::new();
    for ty in y0..y1.max(y0 + 1) {
        for tx in x0..x1.max(x0 + 1) {
            out.push(TileKey { page: v.page, lod, tx, ty });
        }
    }
    out.sort_by(|a, b| {
        let da = (a.tx as f64 - cx).hypot(a.ty as f64 - cy);
        let db = (b.tx as f64 - cx).hypot(b.ty as f64 - cy);
        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(b))
    });
    out
}

/// Region of the page, in points, covered by a tile.
pub fn tile_rect(k: TileKey) -> [f64; 4] {
    let t = TILE as f64 / lod_scale(k.lod);
    let x = k.tx as f64 * t;
    let y = k.ty as f64 * t;
    [x, y, x + t, y + t]
}

/// Rasterises page regions. Implemented by PDFium in `inkwell-pdf`; implemented
/// by a stub in tests.
pub trait PageRasterizer {
    fn page_size_pt(&self, page: u32) -> Option<(f64, f64)>;
    /// `rect` is in points; output must be `px` by `px` RGB8.
    fn rasterize(&self, page: u32, rect: [f64; 4], px: u32) -> Option<Tile>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lookup {
    /// Sharp tile ready.
    Exact,
    /// Nothing at this LOD yet; a coarser tile is being shown upscaled while
    /// the sharp one renders. This is what stops zooming from flashing white.
    Coarser(i8),
    /// Nothing at all to draw yet.
    Miss,
}

struct Entry {
    tile: Tile,
    last_used: u64,
}

pub struct TileCache {
    budget: usize,
    used: usize,
    clock: u64,
    map: HashMap<TileKey, Entry>,
    /// Tiles requested but not yet delivered.
    pending: Vec<TileKey>,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

impl TileCache {
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            budget: budget_bytes,
            used: 0,
            clock: 0,
            map: HashMap::new(),
            pending: Vec::new(),
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
    pub fn bytes_used(&self) -> usize {
        self.used
    }
    pub fn pending(&self) -> &[TileKey] {
        &self.pending
    }

    /// Look up a tile for drawing, falling back to a coarser LOD if the exact
    /// one is not resident yet.
    pub fn lookup(&mut self, k: TileKey) -> Lookup {
        self.clock += 1;
        if let Some(e) = self.map.get_mut(&k) {
            e.last_used = self.clock;
            self.hits += 1;
            return Lookup::Exact;
        }
        self.misses += 1;
        // walk down to coarser levels; each step halves the tile grid
        let mut lod = k.lod;
        let (mut tx, mut ty) = (k.tx, k.ty);
        while lod > LOD_MIN {
            lod -= 1;
            tx = tx.div_euclid(2);
            ty = ty.div_euclid(2);
            let ck = TileKey { page: k.page, lod, tx, ty };
            if let Some(e) = self.map.get_mut(&ck) {
                e.last_used = self.clock;
                return Lookup::Coarser(lod);
            }
        }
        Lookup::Miss
    }

    pub fn contains(&self, k: &TileKey) -> bool {
        self.map.contains_key(k)
    }

    pub fn insert(&mut self, k: TileKey, tile: Tile) {
        self.clock += 1;
        self.pending.retain(|p| p != &k);
        if let Some(old) = self.map.remove(&k) {
            self.used -= old.tile.bytes();
        }
        self.used += tile.bytes();
        self.map.insert(k, Entry { tile, last_used: self.clock });
        self.evict_to_budget();
    }

    pub fn get(&self, k: &TileKey) -> Option<&Tile> {
        self.map.get(k).map(|e| &e.tile)
    }

    fn evict_to_budget(&mut self) {
        while self.used > self.budget && self.map.len() > 1 {
            let victim = self
                .map
                .iter()
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| *k);
            match victim {
                Some(k) => {
                    if let Some(e) = self.map.remove(&k) {
                        self.used -= e.tile.bytes();
                        self.evictions += 1;
                    }
                }
                None => break,
            }
        }
    }

    /// Queue whatever the viewport needs and cancel anything it no longer does.
    ///
    /// Cancellation matters: while panning fast, most in-flight renders are for
    /// tiles that have already scrolled off screen. Letting them finish starves
    /// the tiles the user is actually looking at.
    pub fn request_for_view(&mut self, v: &View) -> Vec<TileKey> {
        let want = visible_tiles(v);
        let before = self.pending.len();
        self.pending.retain(|p| want.contains(p));
        let cancelled = before - self.pending.len();
        let _ = cancelled;

        let mut new = Vec::new();
        for k in want {
            if !self.map.contains_key(&k) && !self.pending.contains(&k) {
                self.pending.push(k);
                new.push(k);
            }
        }
        new
    }

    /// Drive one round of rendering synchronously. In the real app this is a
    /// thread pool; the ordering and bookkeeping are identical.
    pub fn pump<R: PageRasterizer>(&mut self, r: &R, max: usize) -> usize {
        let todo: Vec<TileKey> = self.pending.iter().take(max).copied().collect();
        let mut done = 0;
        for k in todo {
            if let Some(t) = r.rasterize(k.page, tile_rect(k), TILE) {
                self.insert(k, t);
                done += 1;
            } else {
                self.pending.retain(|p| p != &k);
            }
        }
        done
    }
}
