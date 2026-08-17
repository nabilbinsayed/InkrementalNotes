//! Adversarial stress test for spatial indexing and AABB bounding box filtering.

use inkwell_core::doc::Document;
use inkwell_core::ink::{Brush, Sample, Stroke, ToolKind};

fn make_stroke(id: u128, samples: Vec<(f64, f64, f64)>, width: f64) -> Stroke {
    let mut stroke = Stroke::new(
        id,
        ToolKind::Pen,
        [0.1, 0.2, 0.3],
        Brush {
            base_width: width,
            ..Default::default()
        },
    );
    for (x, y, p) in samples {
        stroke.samples.push(Sample::new(x, y, p, 0.0));
    }
    stroke
}

#[test]
fn single_dot_bbox_and_erase() {
    let mut doc = Document::for_pdf(2);
    // Dot at (100.0, 100.0) with width 10.0 (half-width = 5.0)
    let s1 = make_stroke(1, vec![(100.0, 100.0, 1.0)], 10.0);
    let bbox = s1.bbox().expect("bbox must exist for 1 sample");
    assert!((bbox[0] - 95.0).abs() < 1e-6, "min_x should be 95.0");
    assert!((bbox[1] - 95.0).abs() < 1e-6, "min_y should be 95.0");
    assert!((bbox[2] - 105.0).abs() < 1e-6, "max_x should be 105.0");
    assert!((bbox[3] - 105.0).abs() < 1e-6, "max_y should be 105.0");

    doc.push_stroke(0, s1);

    // Erase near dot within radius 10.0 at (108.0, 100.0) -> distance is 8.0 < 10.0 + 5.0
    let removed = doc.erase_strokes_near(0, 108.0, 100.0, 10.0);
    assert_eq!(removed, vec![1], "Single dot should be erased");
}

#[test]
fn diagonal_stroke_spatial_accuracy() {
    let mut doc = Document::for_pdf(1);
    // Diagonal stroke from (0, 0) to (500, 500) with 50 samples
    let samples: Vec<(f64, f64, f64)> = (0..=50)
        .map(|i| {
            let t = i as f64 * 10.0;
            (t, t, 0.5)
        })
        .collect();
    let s = make_stroke(42, samples, 4.0);
    doc.push_stroke(0, s);

    // 1. Erase at off-diagonal point (0, 500) — within AABB [ -2, -2, 502, 502 ] but far from stroke line
    let removed_miss = doc.erase_strokes_near(0, 0.0, 500.0, 10.0);
    assert!(removed_miss.is_empty(), "Off-diagonal query in AABB corner must not erase stroke");
    assert_eq!(doc.stroke_count(), 1);

    // 2. Erase at midpoint (250, 250) — directly on stroke
    let removed_hit = doc.erase_strokes_near(0, 250.0, 250.0, 5.0);
    assert_eq!(removed_hit, vec![42], "Midpoint query must erase diagonal stroke");
    assert_eq!(doc.stroke_count(), 0);
}

#[test]
fn negative_coordinates_origin_crossing() {
    let mut doc = Document::for_pdf(1);
    // Stroke crossing from (-200, -100) to (200, 100)
    let samples: Vec<(f64, f64, f64)> = (-20..=20)
        .map(|i| {
            let t = i as f64 * 10.0;
            (t, t * 0.5, 0.5)
        })
        .collect();
    let s = make_stroke(99, samples, 2.0);
    let bbox = s.bbox().unwrap();
    assert!(bbox[0] < -199.0);
    assert!(bbox[1] < -99.0);
    assert!(bbox[2] > 199.0);
    assert!(bbox[3] > 99.0);

    doc.push_stroke(0, s);

    // Erase in rectangle in negative quadrant
    let removed = doc.erase_strokes_in_rect(0, -150.0, -80.0, -100.0, -40.0);
    assert_eq!(removed, vec![99], "Rect in negative quadrant should intersect stroke");
}

#[test]
fn erase_in_rect_aabb_filter_integrity() {
    let mut doc = Document::for_pdf(1);
    let s = make_stroke(101, vec![(10.0, 10.0, 0.5), (20.0, 20.0, 0.5)], 2.0);
    doc.push_stroke(0, s);

    // Rect strictly to the left: [ -50, 0, 5, 50 ]
    let miss = doc.erase_strokes_in_rect(0, -50.0, 0.0, 5.0, 50.0);
    assert!(miss.is_empty(), "Disjoint rect must not hit");

    // Rect strictly to the right: [ 50, 0, 100, 50 ]
    let miss2 = doc.erase_strokes_in_rect(0, 50.0, 0.0, 100.0, 50.0);
    assert!(miss2.is_empty(), "Disjoint rect must not hit");

    // Rect strictly above / below
    let miss3 = doc.erase_strokes_in_rect(0, 0.0, 50.0, 50.0, 100.0);
    assert!(miss3.is_empty(), "Disjoint rect must not hit");

    // Overlapping rect
    let hit = doc.erase_strokes_in_rect(0, 15.0, 15.0, 25.0, 25.0);
    assert_eq!(hit, vec![101], "Overlapping rect must hit");
}

#[test]
fn multi_sheet_isolation() {
    let mut doc = Document::for_pdf(5);
    doc.push_stroke(0, make_stroke(1, vec![(50.0, 50.0, 0.5)], 2.0));
    doc.push_stroke(1, make_stroke(2, vec![(50.0, 50.0, 0.5)], 2.0));
    doc.push_stroke(2, make_stroke(3, vec![(50.0, 50.0, 0.5)], 2.0));

    // Erase on sheet 1 at (50, 50)
    let removed = doc.erase_strokes_near(1, 50.0, 50.0, 10.0);
    assert_eq!(removed, vec![2]);

    // Sheet 0 and 2 must remain intact
    assert_eq!(doc.sheets[0].stroke_count(), 1);
    assert_eq!(doc.sheets[1].stroke_count(), 0);
    assert_eq!(doc.sheets[2].stroke_count(), 1);
}

#[test]
fn stress_5000_strokes_correctness() {
    let mut doc = Document::for_pdf(10);
    for i in 0..5000 {
        let sheet = i % 10;
        let x = (i as f64 * 37.0) % 1000.0;
        let y = (i as f64 * 53.0) % 1000.0;
        let s = make_stroke(i as u128, vec![(x, y, 0.5), (x + 5.0, y + 5.0, 0.5)], 2.0);
        doc.push_stroke(sheet, s);
    }
    assert_eq!(doc.stroke_count(), 5000);

    // Erase at (500, 500) with radius 50 on sheet 0
    let removed = doc.erase_strokes_near(0, 500.0, 500.0, 50.0);
    // Verify each removed stroke was actually within radius
    for id in &removed {
        let x = (*id as f64 * 37.0) % 1000.0;
        let y = (*id as f64 * 53.0) % 1000.0;
        let d1 = (x - 500.0).hypot(y - 500.0);
        let d2 = (x + 5.0 - 500.0).hypot(y + 5.0 - 500.0);
        assert!(d1 < 52.0 || d2 < 52.0, "Removed stroke must be within radius");
    }
    assert_eq!(doc.stroke_count(), 5000 - removed.len());
}
