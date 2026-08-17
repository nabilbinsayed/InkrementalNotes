//! Ink maths: filtering, variable-width ribbon geometry, simplification.
//!
//! This is a direct port of `src/ink.js` from the M0 spike, and that is
//! intentional: the geometry that draws on screen and the geometry that lands
//! in the PDF are produced by the same algorithm, so they can never diverge.

use serde::{Deserialize, Serialize};

pub const NOMINAL_HZ: f64 = 233.0; // Huion H640P report rate

// ---------------------------------------------------------------------------
// One-Euro filter
// ---------------------------------------------------------------------------

/// Adaptive low-pass filter. Heavy smoothing when the pen is slow (kills
/// tremor), light smoothing when it is fast (kills lag). Strictly better than
/// a fixed EMA for ink. Casiez, Roussel & Vogel, CHI 2012.
#[derive(Debug, Clone)]
pub struct OneEuro {
    min_cutoff: f64,
    beta: f64,
    d_cutoff: f64,
    x_prev: Option<f64>,
    dx_prev: Option<f64>,
    t_prev: Option<f64>,
}

impl Default for OneEuro {
    fn default() -> Self {
        Self::new(1.1, 0.006, 1.0)
    }
}

impl OneEuro {
    pub fn new(min_cutoff: f64, beta: f64, d_cutoff: f64) -> Self {
        Self { min_cutoff, beta, d_cutoff, x_prev: None, dx_prev: None, t_prev: None }
    }

    fn alpha(cutoff: f64, dt: f64) -> f64 {
        let tau = 1.0 / (2.0 * std::f64::consts::PI * cutoff);
        1.0 / (1.0 + tau / dt)
    }

    pub fn reset(&mut self) {
        self.x_prev = None;
        self.dx_prev = None;
        self.t_prev = None;
    }

    /// `t_ms` is a monotonic timestamp in milliseconds.
    pub fn filter(&mut self, v: f64, t_ms: f64) -> f64 {
        let t = t_ms / 1000.0;
        let dt = match self.t_prev {
            Some(p) => (t - p).max(1e-4),
            None => 1.0 / NOMINAL_HZ,
        };
        self.t_prev = Some(t);

        let dv = match self.x_prev {
            Some(x) => (v - x) / dt,
            None => 0.0,
        };
        let a_d = Self::alpha(self.d_cutoff, dt);
        let edv = match self.dx_prev {
            Some(d) => a_d * dv + (1.0 - a_d) * d,
            None => dv,
        };
        self.dx_prev = Some(edv);

        let cutoff = self.min_cutoff + self.beta * edv.abs();
        let a = Self::alpha(cutoff, dt);
        let out = match self.x_prev {
            Some(x) => a * v + (1.0 - a) * x,
            None => v,
        };
        self.x_prev = Some(out);
        out
    }
}

// ---------------------------------------------------------------------------
// Brush
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Brush {
    pub base_width: f64,
    /// Pressure response exponent. <1 softer, >1 sharper.
    pub gamma: f64,
    /// Fraction of `base_width` retained at zero pressure.
    pub min_ratio: f64,
}

impl Default for Brush {
    fn default() -> Self {
        Self { base_width: 3.2, gamma: 1.0, min_ratio: 0.22 }
    }
}

impl Brush {
    pub fn width_for(&self, pressure: f64) -> f64 {
        let p = pressure.clamp(0.0, 1.0).powf(self.gamma);
        self.base_width * (self.min_ratio + (1.0 - self.min_ratio) * p)
    }
}

// ---------------------------------------------------------------------------
// Samples and strokes
// ---------------------------------------------------------------------------

/// One device sample. Layout matches the M0 capture JSON: `[x, y, pressure, t_ms]`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub p: f64,
    pub t: f64,
}

impl Sample {
    pub fn new(x: f64, y: f64, p: f64, t: f64) -> Self {
        Self { x, y, p, t }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ToolKind {
    Pen,
    Highlighter,
}

impl ToolKind {
    pub fn as_u8(self) -> u8 {
        match self {
            ToolKind::Pen => 0,
            ToolKind::Highlighter => 1,
        }
    }
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => ToolKind::Highlighter,
            _ => ToolKind::Pen,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    /// Stable identity. Survives round-trips through third-party PDF editors
    /// via the annotation's `/NM` key, and is the basis for future CRDT merge.
    pub id: u128,
    pub kind: ToolKind,
    pub rgb: [f64; 3],
    pub brush: Brush,
    pub samples: Vec<Sample>,
}

impl Stroke {
    pub fn new(id: u128, kind: ToolKind, rgb: [f64; 3], brush: Brush) -> Self {
        Self { id, kind, rgb, brush, samples: Vec::new() }
    }

    pub fn id_hex(&self) -> String {
        format!("{:032x}", self.id)
    }

    /// Axis-aligned bounds of the *rendered* ribbon, i.e. including half-width.
    pub fn bbox(&self) -> Option<[f64; 4]> {
        let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for s in &self.samples {
            let h = self.brush.width_for(s.p) / 2.0;
            b[0] = b[0].min(s.x - h);
            b[1] = b[1].min(s.y - h);
            b[2] = b[2].max(s.x + h);
            b[3] = b[3].max(s.y + h);
        }
        if self.samples.is_empty() { None } else { Some(b) }
    }

    /// Centreline, decimated for the `/InkList` interop layer.
    pub fn centreline(&self, stride: usize) -> Vec<(f64, f64)> {
        let stride = stride.max(1);
        self.samples.iter().step_by(stride).map(|s| (s.x, s.y)).collect()
    }
}

// ---------------------------------------------------------------------------
// Live stroke builder (the pen-down..pen-up path)
// ---------------------------------------------------------------------------

pub struct StrokeBuilder {
    stroke: Stroke,
    fx: OneEuro,
    fy: OneEuro,
    p_ema: Option<f64>,
    warmup: u32,
    smoothing: bool,
}

impl StrokeBuilder {
    pub fn new(id: u128, kind: ToolKind, rgb: [f64; 3], brush: Brush, smoothing: bool) -> Self {
        Self {
            stroke: Stroke::new(id, kind, rgb, brush),
            fx: OneEuro::default(),
            fy: OneEuro::default(),
            p_ema: None,
            warmup: 0,
            smoothing,
        }
    }

    /// Push one raw device sample. Returns `None` if the sample was rejected as
    /// a duplicate.
    pub fn push(&mut self, x: f64, y: f64, pressure: f64, t_ms: f64) -> Option<Sample> {
        self.warmup += 1;
        // EMR tablets emit 1-2 junk pressure values on pen-down. Clamp them
        // instead of drawing a blob at the start of every stroke.
        let p_in = if self.warmup <= 2 { pressure.min(0.35) } else { pressure };

        let (fx, fy) = if self.smoothing {
            (self.fx.filter(x, t_ms), self.fy.filter(y, t_ms))
        } else {
            (x, y)
        };
        let p = match self.p_ema {
            Some(prev) => prev + 0.35 * (p_in - prev),
            None => p_in,
        };
        self.p_ema = Some(p);

        if let Some(last) = self.stroke.samples.last() {
            if (fx - last.x).hypot(fy - last.y) < 0.05 {
                return None;
            }
        }
        let s = Sample::new(fx, fy, p.clamp(0.0, 1.0), t_ms);
        self.stroke.samples.push(s);
        Some(s)
    }

    pub fn finish(mut self, simplify_tol: f64) -> Stroke {
        if simplify_tol > 0.0 {
            self.stroke.samples = simplify(&self.stroke.samples, simplify_tol);
        }
        self.stroke
    }

    pub fn peek(&self) -> &Stroke {
        &self.stroke
    }
}

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

/// Pressure-aware Ramer-Douglas-Peucker. A point is also kept when pressure
/// changes sharply, so taper survives decimation.
pub fn simplify(pts: &[Sample], tol: f64) -> Vec<Sample> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    *keep.last_mut().unwrap() = true;
    rdp(pts, 0, pts.len() - 1, tol, &mut keep);

    // preserve pressure inflections
    for i in 1..pts.len() - 1 {
        let dp = (pts[i].p - pts[i - 1].p).abs();
        if dp > 0.08 {
            keep[i] = true;
        }
    }
    pts.iter().zip(&keep).filter(|(_, k)| **k).map(|(s, _)| *s).collect()
}

fn rdp(pts: &[Sample], first: usize, last: usize, tol: f64, keep: &mut [bool]) {
    if last <= first + 1 {
        return;
    }
    let (a, b) = (pts[first], pts[last]);
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len = dx.hypot(dy);
    let mut worst = 0.0;
    let mut idx = first;
    // indexed on purpose: we need to remember WHICH point was farthest, not just
    // its value, so RDP can recurse around it.
    #[allow(clippy::needless_range_loop)]
    for i in first + 1..last {
        let d = if len < 1e-9 {
            (pts[i].x - a.x).hypot(pts[i].y - a.y)
        } else {
            ((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx).abs() / len
        };
        if d > worst {
            worst = d;
            idx = i;
        }
    }
    if worst > tol {
        keep[idx] = true;
        rdp(pts, first, idx, tol, keep);
        rdp(pts, idx, last, tol, keep);
    }
}

// ---------------------------------------------------------------------------
// Variable-width ribbon outline  -- THE key geometry
// ---------------------------------------------------------------------------

/// Build the closed outline polygon of a variable-width stroke.
///
/// PDF's stroke operator (`S`) has exactly one line width, so pressure cannot
/// be expressed with it. Instead we offset the centreline by half the
/// pressure-derived width on both sides, join the two sides with round caps,
/// and emit the result as a **fill** (`f`). That is what makes pressure
/// survive into a completely standard PDF.
pub fn ribbon_outline(stroke: &Stroke, cap_steps: usize) -> Vec<(f64, f64)> {
    let pts = &stroke.samples;
    if pts.is_empty() {
        return Vec::new();
    }
    if pts.len() == 1 {
        return circle(pts[0].x, pts[0].y, stroke.brush.width_for(pts[0].p) / 2.0, cap_steps * 4);
    }

    let n = pts.len();
    let mut left = Vec::with_capacity(n);
    let mut right = Vec::with_capacity(n);
    // indexed on purpose: each offset point needs its neighbours i-1 and i+1
    #[allow(clippy::needless_range_loop)]
    for i in 0..n {
        let a = pts[i.saturating_sub(1)];
        let b = pts[(i + 1).min(n - 1)];
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = dx.hypot(dy).max(1e-9);
        let (nx, ny) = (-dy / l, dx / l);
        let h = stroke.brush.width_for(pts[i].p) / 2.0;
        left.push((pts[i].x + nx * h, pts[i].y + ny * h));
        right.push((pts[i].x - nx * h, pts[i].y - ny * h));
    }

    let mut poly = left.clone();
    poly.extend(arc(
        (pts[n - 1].x, pts[n - 1].y),
        *left.last().unwrap(),
        *right.last().unwrap(),
        cap_steps,
    ));
    poly.extend(right.iter().rev().copied());
    poly.extend(arc(
        (pts[0].x, pts[0].y),
        right[0],
        left[0],
        cap_steps,
    ));
    poly
}

fn circle(cx: f64, cy: f64, r: f64, steps: usize) -> Vec<(f64, f64)> {
    (0..steps)
        .map(|i| {
            let a = i as f64 / steps as f64 * std::f64::consts::TAU;
            (cx + r * a.cos(), cy + r * a.sin())
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Smoothing the outline into cubic Beziers
// ---------------------------------------------------------------------------

/// One cubic segment: two control points and an end point. Start point is the
/// previous segment's end (or the path's `move-to` for the first).
pub type Cubic = [(f64, f64); 3];

/// Convert a closed polygon into interpolating cubic Beziers (uniform
/// Catmull-Rom, converted to Bezier control points).
///
/// WHY THIS IS NOT OPTIONAL. Emitting the ribbon outline as a dense polyline is
/// mathematically fine and still "vector", but the straight segments become
/// visible as faceting once you zoom past roughly 400%, which is exactly the
/// polygonal look this project exists to avoid. Simplification makes it worse:
/// the fewer points you keep, the longer each flat segment is.
///
/// Catmull-Rom is used rather than a least-squares Schneider fit because it
/// *interpolates* -- the curve passes exactly through every outline point, so
/// the rendered shape cannot drift away from the pressure geometry. A Schneider
/// fit would produce fewer segments but would need error bounds to stay honest.
pub fn polygon_to_cubics(p: &[(f64, f64)]) -> Vec<Cubic> {
    let n = p.len();
    if n < 3 {
        return Vec::new();
    }
    let at = |i: isize| -> (f64, f64) { p[i.rem_euclid(n as isize) as usize] };
    let mut out = Vec::with_capacity(n);
    for i in 0..n as isize {
        let p0 = at(i - 1);
        let p1 = at(i);
        let p2 = at(i + 1);
        let p3 = at(i + 2);
        let c1 = (p1.0 + (p2.0 - p0.0) / 6.0, p1.1 + (p2.1 - p0.1) / 6.0);
        let c2 = (p2.0 - (p3.0 - p1.0) / 6.0, p2.1 - (p3.1 - p1.1) / 6.0);
        out.push([c1, c2, p2]);
    }
    out
}

/// Evaluate a cubic Bezier. Used by tests and by any future flattener.
pub fn cubic_at(p0: (f64, f64), c: &Cubic, t: f64) -> (f64, f64) {
    let u = 1.0 - t;
    let (a, b, cc, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    (
        a * p0.0 + b * c[0].0 + cc * c[1].0 + d * c[2].0,
        a * p0.1 + b * c[0].1 + cc * c[1].1 + d * c[2].1,
    )
}

/// Smooth an **open** polyline into interpolating cubics.
///
/// Uses **centripetal** knot spacing (`t_{i+1} = t_i + |Δp|^0.5`) rather than
/// uniform. This matters a lot: RDP simplification deliberately produces
/// unevenly spaced points, and uniform Catmull-Rom overshoots on uneven data.
/// End tangents come from a three-point one-sided derivative, which is
/// second-order accurate; the naive `2*p0 - p1` reflection is not, and it showed
/// up as measurable error on the first and last segment of every stroke.
///
/// Do NOT use this across the whole closed outline. The outline contains
/// *intentional* sharp corners where a long edge meets a round cap, and smoothing
/// through a sharp corner overshoots hard: measured error on a test circle went
/// from 0.046 pt (plain polyline) to 2.37 pt -- fifty times worse, and visible as
/// a bulge at every stroke end.
pub fn open_polyline_to_cubics(p: &[(f64, f64)]) -> Vec<Cubic> {
    let n = p.len();
    if n < 2 {
        return Vec::new();
    }
    if n == 2 {
        // exact straight line expressed as a cubic
        let (a, b) = (p[0], p[1]);
        let d = (b.0 - a.0, b.1 - a.1);
        return vec![[
            (a.0 + d.0 / 3.0, a.1 + d.1 / 3.0),
            (a.0 + 2.0 * d.0 / 3.0, a.1 + 2.0 * d.1 / 3.0),
            b,
        ]];
    }

    // centripetal knots
    let mut t = vec![0.0f64; n];
    for i in 1..n {
        let d = (p[i].0 - p[i - 1].0).hypot(p[i].1 - p[i - 1].1);
        t[i] = t[i - 1] + d.sqrt().max(1e-6);
    }

    // tangents dp/dt
    let mut m = vec![(0.0f64, 0.0f64); n];
    for i in 1..n - 1 {
        let dt = t[i + 1] - t[i - 1];
        m[i] = ((p[i + 1].0 - p[i - 1].0) / dt, (p[i + 1].1 - p[i - 1].1) / dt);
    }
    // three-point one-sided derivatives at the ends
    m[0] = one_sided(p[0], p[1], p[2], t[0], t[1], t[2]);
    let (a, b, c) = (p[n - 1], p[n - 2], p[n - 3]);
    let (ta, tb, tc) = (t[n - 1], t[n - 2], t[n - 3]);
    m[n - 1] = one_sided(a, b, c, ta, tb, tc);

    (0..n - 1)
        .map(|i| {
            let dt = t[i + 1] - t[i];
            [
                (p[i].0 + m[i].0 * dt / 3.0, p[i].1 + m[i].1 * dt / 3.0),
                (p[i + 1].0 - m[i + 1].0 * dt / 3.0, p[i + 1].1 - m[i + 1].1 * dt / 3.0),
                p[i + 1],
            ]
        })
        .collect()
}

/// Derivative at `p0` of the parabola through `(t0,p0) (t1,p1) (t2,p2)`.
fn one_sided(
    p0: (f64, f64),
    p1: (f64, f64),
    p2: (f64, f64),
    t0: f64,
    t1: f64,
    t2: f64,
) -> (f64, f64) {
    let (h1, h2) = (t1 - t0, t2 - t0);
    let den = h1 * h2 * (h2 - h1);
    if den.abs() < 1e-12 {
        let d = if (t1 - t0).abs() < 1e-9 { 1e-9 } else { t1 - t0 };
        return ((p1.0 - p0.0) / d, (p1.1 - p0.1) / d);
    }
    let f = |a: f64, b: f64, c: f64| {
        ((b - a) * h2 * h2 - (c - a) * h1 * h1) / den
    };
    (f(p0.0, p1.0, p2.0), f(p0.1, p1.1, p2.1))
}


// ---------------------------------------------------------------------------
// The path actually written to the PDF
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathCmd {
    MoveTo((f64, f64)),
    LineTo((f64, f64)),
    CurveTo(Cubic),
    Close,
}

/// The ribbon as a fillable path: smooth cubics along the two long edges, plain
/// chords around the round caps, sharp corners preserved where they belong.
pub fn ribbon_path(s: &Stroke, cap_steps: usize) -> Vec<PathCmd> {
    let pts = &s.samples;
    if pts.is_empty() {
        return Vec::new();
    }
    if pts.len() == 1 {
        // a tap: a plain disc, which is genuinely closed and smooth
        let poly = circle(pts[0].x, pts[0].y, s.brush.width_for(pts[0].p) / 2.0, cap_steps * 4);
        let mut out = vec![PathCmd::MoveTo(poly[0])];
        out.extend(polygon_to_cubics(&poly).into_iter().map(PathCmd::CurveTo));
        out.push(PathCmd::Close);
        return out;
    }

    let (left, right) = ribbon_edges(s);
    let n = left.len();
    let end_cap = arc((pts[n - 1].x, pts[n - 1].y), left[n - 1], right[n - 1], cap_steps);
    let start_cap = arc((pts[0].x, pts[0].y), right[0], left[0], cap_steps);
    let right_rev: Vec<(f64, f64)> = right.iter().rev().copied().collect();

    let mut out = Vec::with_capacity(2 * n + 2 * cap_steps + 4);
    out.push(PathCmd::MoveTo(left[0]));
    out.extend(open_polyline_to_cubics(&left).into_iter().map(PathCmd::CurveTo));
    for p in end_cap {
        out.push(PathCmd::LineTo(p));
    }
    out.push(PathCmd::LineTo(right_rev[0]));
    out.extend(open_polyline_to_cubics(&right_rev).into_iter().map(PathCmd::CurveTo));
    for p in start_cap {
        out.push(PathCmd::LineTo(p));
    }
    out.push(PathCmd::Close);
    out
}

/// The two offset curves, before caps are attached.
#[allow(clippy::type_complexity)]
pub fn ribbon_edges(s: &Stroke) -> (Vec<(f64, f64)>, Vec<(f64, f64)>) {
    let pts = &s.samples;
    let n = pts.len();
    let mut left = Vec::with_capacity(n);
    let mut right = Vec::with_capacity(n);
    for i in 0..n {
        let a = pts[i.saturating_sub(1)];
        let b = pts[(i + 1).min(n - 1)];
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = dx.hypot(dy).max(1e-9);
        let (nx, ny) = (-dy / l, dx / l);
        let h = s.brush.width_for(pts[i].p) / 2.0;
        left.push((pts[i].x + nx * h, pts[i].y + ny * h));
        right.push((pts[i].x - nx * h, pts[i].y - ny * h));
    }
    (left, right)
}


fn arc(c: (f64, f64), from: (f64, f64), to: (f64, f64), steps: usize) -> Vec<(f64, f64)> {
    let a0 = (from.1 - c.1).atan2(from.0 - c.0);
    let mut a1 = (to.1 - c.1).atan2(to.0 - c.0);
    let r = (from.0 - c.0).hypot(from.1 - c.1);
    while a1 - a0 > std::f64::consts::PI {
        a1 -= std::f64::consts::TAU;
    }
    while a1 - a0 < -std::f64::consts::PI {
        a1 += std::f64::consts::TAU;
    }
    (1..steps)
        .map(|i| {
            let a = a0 + (a1 - a0) * i as f64 / steps as f64;
            (c.0 + r * a.cos(), c.1 + r * a.sin())
        })
        .collect()
}

// ---------------------------------------------------------------------------
// id generation (no external rand dependency)
// ---------------------------------------------------------------------------

/// Deterministic-per-process 128-bit id source. Good enough for object identity
/// within a document; swap for a real UUID crate if you ever need cross-machine
/// uniqueness guarantees stronger than 2^-64.
pub struct IdGen {
    state: u128,
}

impl IdGen {
    pub fn from_entropy() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0x9E3779B97F4A7C15);
        Self { state: nanos | 1 }
    }
    pub fn seeded(seed: u128) -> Self {
        Self { state: seed | 1 }
    }
    pub fn next_id(&mut self) -> u128 {
        // splitmix-style mixing, widened to 128 bits
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15_F39C_C060_5CED_C835);
        let mut z = self.state;
        z = (z ^ (z >> 62)).wrapping_mul(0xBF58_476D_1CE4_E5B9_9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 59)).wrapping_mul(0x94D0_49BB_1331_11EB_C2B2_AE3D_27D4_EB4F);
        z ^ (z >> 63)
    }
}
