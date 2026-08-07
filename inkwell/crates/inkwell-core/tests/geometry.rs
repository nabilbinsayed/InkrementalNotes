//! Geometric quality of the emitted ink outline.
//!
//! These tests exist because a 900% render of the first working version showed
//! visible faceting: the outline was a dense polyline, and straight segments
//! become obvious once you zoom past roughly 400%. Bezier smoothing was
//! initially written off in the README as "a size optimisation, not a
//! correctness one". That was wrong. It is the difference between crisp ink and
//! the polygonal look this project exists to avoid, and these tests keep it from
//! regressing silently.

use inkwell_core::ink::*;

/// Flatten a whole emitted path back into points, densely.
fn flatten_path(path: &[PathCmd], per_seg: usize) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut cur = (0.0, 0.0);
    for cmd in path {
        match cmd {
            PathCmd::MoveTo(p) | PathCmd::LineTo(p) => {
                out.push(*p);
                cur = *p;
            }
            PathCmd::CurveTo(c) => {
                for k in 0..=per_seg {
                    out.push(cubic_at(cur, c, k as f64 / per_seg as f64));
                }
                cur = c[2];
            }
            PathCmd::Close => {}
        }
    }
    out
}

/// Flatten only the smoothed run of cubics that follows the initial MoveTo, i.e.
/// one long edge of the ribbon. The caps are deliberately chorded and must not be
/// judged against the edge's circle.
fn flatten_first_run(path: &[PathCmd], per_seg: usize) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut cur = match path.first() {
        Some(PathCmd::MoveTo(p)) => *p,
        _ => return out,
    };
    for cmd in &path[1..] {
        match cmd {
            PathCmd::CurveTo(c) => {
                for k in 0..=per_seg {
                    out.push(cubic_at(cur, c, k as f64 / per_seg as f64));
                }
                cur = c[2];
            }
            _ => break,
        }
    }
    out
}

/// A constant-pressure circular arc. Each offset edge is then an exact circle,
/// so error can be measured against truth instead of against another
/// approximation.
fn arc_stroke(radius: f64, n: usize, width: f64) -> Stroke {
    let brush = Brush { base_width: width, gamma: 1.0, min_ratio: 1.0 }; // constant width
    let mut b = StrokeBuilder::new(1, ToolKind::Pen, [0.0; 3], brush, false);
    for i in 0..n {
        let a = std::f64::consts::PI * 0.5 * i as f64 / (n - 1) as f64;
        b.push(300.0 + radius * a.cos(), 400.0 + radius * a.sin(), 1.0, i as f64 * 4.3);
    }
    b.finish(0.0)
}

const CENTRE: (f64, f64) = (300.0, 400.0);

/// For a constant-width arc each offset edge is itself a circle, so its mean
/// radius is the ground truth -- no need to know the normal's sign convention.
fn dist(p: (f64, f64)) -> f64 {
    (p.0 - CENTRE.0).hypot(p.1 - CENTRE.1)
}

/// Max deviation from a circle of radius `target`, ignoring points that belong to
/// the ribbon's other edge.
///
/// The ribbon has TWO edges `w` apart. A naive "distance from ideal radius"
/// filter picks up the far edge and reports an error of exactly `w`, which looks
/// like a catastrophic geometry bug but is purely a measurement mistake. It was
/// one, twice, in this file.
fn edge_error(pts: &[(f64, f64)], target: f64, band: f64) -> f64 {
    pts.iter()
        .map(|p| dist(*p))
        .filter(|d| (*d - target).abs() < band)
        .map(|d| (d - target).abs())
        .fold(0.0f64, f64::max)
}

#[test]
fn cubics_interpolate_every_outline_point() {
    let s = arc_stroke(80.0, 40, 6.0);
    let (left, _) = ribbon_edges(&s);
    let cubics = open_polyline_to_cubics(&left);
    assert_eq!(cubics.len(), left.len() - 1, "one cubic per edge segment");
    let poly = left;

    // Segment i must END exactly on outline point i+1. Interpolation is why we
    // use Catmull-Rom rather than a least-squares fit: the rendered shape can
    // never drift away from the pressure geometry.
    for (i, c) in cubics.iter().enumerate() {
        let want = poly[(i + 1) % poly.len()];
        assert!(
            (c[2].0 - want.0).abs() < 1e-9 && (c[2].1 - want.1).abs() < 1e-9,
            "segment {i} does not land on its outline point"
        );
    }
}

#[test]
fn cubics_are_c1_continuous() {
    let s = arc_stroke(80.0, 40, 6.0);
    let (left, _) = ribbon_edges(&s);
    let cubics = open_polyline_to_cubics(&left);

    // The outgoing tangent of segment i must be parallel to the incoming tangent
    // of segment i+1, or the fill shows a visible kink at every joint.
    let mut worst: f64 = 0.0;
    for i in 0..cubics.len() - 1 {
        let j = i + 1;
        let joint = cubics[i][2];
        let incoming = (joint.0 - cubics[i][1].0, joint.1 - cubics[i][1].1);
        let outgoing = (cubics[j][0].0 - joint.0, cubics[j][0].1 - joint.1);
        let (la, lb) = (incoming.0.hypot(incoming.1), outgoing.0.hypot(outgoing.1));
        if la < 1e-9 || lb < 1e-9 {
            continue;
        }
        let cos = (incoming.0 * outgoing.0 + incoming.1 * outgoing.1) / (la * lb);
        worst = worst.max(cos.clamp(-1.0, 1.0).acos().to_degrees());
    }
    // Catmull-Rom -> Bezier is exactly C1: both tangents equal (P[i+2]-P[i])/6.
    // The tolerance covers f64 rounding through acos, nothing more.
    println!("worst tangent break: {worst:.2e} degrees");
    assert!(worst < 1e-4, "tangents break by up to {worst:.2e} degrees at the joints");
}

#[test]
fn bezier_outline_beats_a_polyline_on_a_known_circle() {
    let (r, w, n) = (80.0, 6.0, 24usize);
    let s = arc_stroke(r, n, w);
    let (left, _) = ribbon_edges(&s);
    let target = left.iter().map(|p| dist(*p)).sum::<f64>() / left.len() as f64;
    let band = w * 0.4; // the other edge is w away, so this cannot reach it

    // Polyline error peaks at the midpoint of each chord (the sagitta).
    let mids: Vec<(f64, f64)> = left
        .windows(2)
        .map(|c| ((c[0].0 + c[1].0) / 2.0, (c[0].1 + c[1].1) / 2.0))
        .collect();
    let poly_err = edge_error(&mids, target, band);
    let bez_err = edge_error(&flatten_first_run(&ribbon_path(&s, 16), 12), target, band);

    println!("radial error @ {n} samples:  polyline {poly_err:.4} pt   bezier {bez_err:.4} pt");
    assert!(poly_err > 1e-4, "measurement broken: polyline shows no error at all");
    assert!(
        bez_err < poly_err / 3.0,
        "bezier ({bez_err:.4}) not much better than polyline ({poly_err:.4})"
    );
    // Well under one device pixel even at 900% zoom on a 2x display.
    assert!(bez_err < 0.05, "bezier outline error {bez_err:.4} pt is visible when zoomed");
}

#[test]
fn faceting_does_not_return_when_the_stroke_is_simplified() {
    // Simplification is what made the original faceting obvious: fewer points
    // means longer flat segments. The Bezier outline must stay smooth anyway.
    let (r, w) = (80.0, 6.0);
    let dense = arc_stroke(r, 200, w);
    let mut sparse = dense.clone();
    sparse.samples = simplify(&dense.samples, 0.4);
    assert!(sparse.samples.len() * 3 < dense.samples.len(), "simplify should bite hard here");

    let (left, _) = ribbon_edges(&sparse);
    let target = left.iter().map(|p| dist(*p)).sum::<f64>() / left.len() as f64;
    let e = edge_error(&flatten_first_run(&ribbon_path(&sparse, 16), 12), target, w * 0.4);
    println!(
        "simplified {} -> {} samples, outline error {e:.4} pt",
        dense.samples.len(),
        sparse.samples.len()
    );
    assert!(e < 0.15, "simplified stroke facets again: {e:.4} pt error");
}

#[test]
fn pressure_variation_is_actually_visible_in_the_geometry() {
    // A brush whose width barely changes with pressure would make all of this
    // pointless. Assert the rendered ribbon really does taper.
    let brush = Brush { base_width: 4.0, gamma: 1.0, min_ratio: 0.22 };
    let mut b = StrokeBuilder::new(1, ToolKind::Pen, [0.0; 3], brush, false);
    let n = 120;
    for i in 0..n {
        let t = i as f64 / (n - 1) as f64;
        b.push(100.0 + t * 200.0, 400.0, 0.05 + 0.9 * t, i as f64 * 4.3);
    }
    let s = b.finish(0.0);

    let poly = flatten_path(&ribbon_path(&s, 16), 6);
    let thickness_at = |x: f64| -> f64 {
        let ys: Vec<f64> = poly.iter().filter(|p| (p.0 - x).abs() < 1.5).map(|p| p.1).collect();
        if ys.len() < 2 {
            return 0.0;
        }
        ys.iter().cloned().fold(f64::MIN, f64::max) - ys.iter().cloned().fold(f64::MAX, f64::min)
    };
    let thin = thickness_at(115.0);
    let thick = thickness_at(285.0);
    println!("ribbon thickness: light end {thin:.2} pt, heavy end {thick:.2} pt");
    assert!(thin > 0.0 && thick > 0.0, "could not measure the ribbon");
    assert!(thick > thin * 2.0, "pressure barely changes width: {thin:.2} -> {thick:.2}");
}

#[test]
fn degenerate_polygons_do_not_panic() {
    assert!(polygon_to_cubics(&[]).is_empty());
    assert!(polygon_to_cubics(&[(0.0, 0.0)]).is_empty());
    assert!(polygon_to_cubics(&[(0.0, 0.0), (1.0, 1.0)]).is_empty());
    assert_eq!(polygon_to_cubics(&[(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)]).len(), 3);
    // all-identical points must not produce NaN control points
    for c in polygon_to_cubics(&[(5.0, 5.0); 6]) {
        for p in c {
            assert!(p.0.is_finite() && p.1.is_finite());
        }
    }
}
