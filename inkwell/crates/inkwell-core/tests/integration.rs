use inkwell_core::codec;
use inkwell_core::doc::{Document, SheetKind};
use inkwell_core::ink::*;
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};
use inkwell_core::wal::{self, FlushPolicy, FlushReason, FlushSignals, Wal, WalEntry};

fn fixture() -> Vec<u8> {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/lecture.pdf");
    std::fs::read(p).unwrap_or_else(|e| panic!("run tools/make_fixture.py first: {e}"))
}

/// A handwriting-like stroke with a realistic pressure envelope.
///
/// `seed` varies the shape AND the pressure profile per stroke. Real handwriting
/// never repeats the same envelope; synthetic data that does will understate how
/// many distinct pressure values a document actually contains.
fn synth_seeded(id: u128, y0: f64, n: usize, kind: ToolKind, seed: u32) -> Stroke {
    let brush = Brush {
        base_width: if kind == ToolKind::Highlighter { 14.0 } else { 2.6 },
        gamma: 0.85 + (seed % 5) as f64 * 0.09,
        ..Default::default()
    };
    let s = seed as f64;
    let mut b = StrokeBuilder::new(id, kind, [0.1, 0.1, 0.3], brush, true);
    for i in 0..n {
        let t = i as f64 / (n - 1) as f64;
        let x = 70.0 + t * (380.0 + s * 11.0);
        let y = y0 + 6.0 * (t * (23.0 + s)).sin() + 2.5 * (t * (57.0 + s * 3.0)).sin();
        // asymmetric envelope + per-stroke ripple: no two strokes share a curve
        let env = (std::f64::consts::PI * t.powf(0.8 + s * 0.03)).sin().powf(0.55);
        let ripple = 0.88 + 0.12 * (t * (9.0 + s * 1.7) + s).sin();
        let p = env * ripple * 0.95 + 0.04;
        b.push(x, y, p.clamp(0.02, 1.0), i as f64 * 4.3);
    }
    b.finish(0.0)
}

fn synth(id: u128, y0: f64, n: usize, kind: ToolKind) -> Stroke {
    synth_seeded(id, y0, n, kind, 1)
}

/// Distinct pressure levels across a document, at 10-bit resolution.
fn pressure_levels(d: &Document) -> usize {
    d.sheets
        .iter()
        .flat_map(|s| s.strokes())
        .flat_map(|s| s.samples.iter())
        .map(|s| (s.p * 1024.0) as u16)
        .collect::<std::collections::HashSet<_>>()
        .len()
}

fn sample_doc(n_strokes: usize) -> Document {
    let mut d = Document::for_pdf(1);
    d.device = inkwell_core::doc::DeviceInfo {
        model: "Huion H640P".into(),
        report_hz: 233.0,
        tilt: false,
    };
    let mut ids = IdGen::seeded(0xC0FFEE);
    for i in 0..n_strokes {
        let kind = if i == 0 { ToolKind::Highlighter } else { ToolKind::Pen };
        d.push_stroke(0, synth_seeded(ids.next_id(), 700.0 - i as f64 * 26.0, 260, kind, i as u32 + 1));
    }
    d.generation = 1;
    d
}

// ===========================================================================
// codec
// ===========================================================================

#[test]
fn codec_roundtrips_within_quantisation_error() {
    let doc = sample_doc(6);
    let strokes: Vec<Stroke> = doc.sheets[0].strokes().cloned().collect();
    let bytes = codec::encode(&strokes);
    let back = codec::decode(&bytes).expect("decode");

    assert_eq!(back.len(), strokes.len());
    for (a, b) in strokes.iter().zip(&back) {
        assert_eq!(a.id, b.id, "stroke identity must survive exactly");
        assert_eq!(a.kind, b.kind);
        assert_eq!(a.samples.len(), b.samples.len());
        for (x, y) in a.samples.iter().zip(&b.samples) {
            assert!((x.x - y.x).abs() <= 1.0 / codec::QUANT, "x drift {} vs {}", x.x, y.x);
            assert!((x.y - y.y).abs() <= 1.0 / codec::QUANT, "y drift");
            assert!((x.p - y.p).abs() <= 1.0 / codec::PQUANT + 1e-9, "pressure drift");
            assert!((x.t - y.t).abs() <= 1.0 / codec::TQUANT, "time drift");
        }
    }
}

#[test]
fn codec_rejects_garbage_instead_of_panicking() {
    assert!(codec::decode(b"").is_err());
    assert!(codec::decode(b"NOPE").is_err());
    let mut v = codec::encode(&[synth(1, 500.0, 20, ToolKind::Pen)]);
    v[4] = 99; // bogus version
    assert!(codec::decode(&v).is_err());
    let good = codec::encode(&[synth(1, 500.0, 200, ToolKind::Pen)]);
    for cut in [6, 30, good.len() / 2, good.len() - 1] {
        assert!(codec::decode(&good[..cut]).is_err(), "truncation at {cut} must error");
    }
}

#[test]
fn codec_rejects_overflowing_varint_and_bounds_allocation() {
    // 10 consecutive bytes with MSB set (varint shift overflow >= 64 bits)
    let bad_varint = [0xFF; 10];
    let mut pos = 0;
    assert!(codec::get_uvarint(&bad_varint, &mut pos).is_err());

    // Shift == 63 with payload > 1
    let bad_shift63 = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02];
    let mut pos2 = 0;
    assert!(codec::get_uvarint(&bad_shift63, &mut pos2).is_err());
}

#[test]
fn pdfobj_skip_value_bounds_checks_and_clamps() {
    use inkwell_core::pdfobj::skip_value;

    // Trailing backslash inside string
    let trailing_escape = b"(\\ ";
    assert!(skip_value(trailing_escape, 0) <= trailing_escape.len());

    // Unterminated dict
    let unterminated_dict = b"<< /Key 123";
    assert!(skip_value(unterminated_dict, 0) <= unterminated_dict.len());

    // Unterminated hex string
    let unterminated_hex = b"<ABC";
    assert!(skip_value(unterminated_hex, 0) <= unterminated_hex.len());

    // Unterminated array
    let unterminated_arr = b"[ 1 2 3";
    assert!(skip_value(unterminated_arr, 0) <= unterminated_arr.len());

    // Abrupt end after slash
    let slash = b"/";
    assert!(skip_value(slash, 0) <= slash.len());
}

#[test]
fn codec_size_is_about_four_bytes_per_sample() {
    let doc = sample_doc(10);
    let strokes: Vec<Stroke> = doc.sheets[0].strokes().cloned().collect();
    let n: usize = strokes.iter().map(|s| s.samples.len()).sum();
    let raw = codec::encode(&strokes).len();
    let per = raw as f64 / n as f64;
    println!("codec: {n} samples -> {raw} bytes ({per:.2} bytes/sample, uncompressed)");
    assert!(per < 6.0, "codec regressed to {per:.2} bytes/sample");
    // extrapolate a genuinely dense page
    let page_kb = per * 60_000.0 / 1024.0;
    println!("  a densely handwritten page (60k samples) ~= {page_kb:.0} KB before zlib");
    assert!(page_kb < 400.0);
}

// ===========================================================================
// ink maths
// ===========================================================================

#[test]
fn ribbon_width_tracks_pressure() {
    let b = Brush::default();
    assert!(b.width_for(1.0) > b.width_for(0.5));
    assert!(b.width_for(0.5) > b.width_for(0.0));
    assert!(b.width_for(0.0) > 0.0, "zero pressure must still have a hairline");

    let s = synth(1, 500.0, 200, ToolKind::Pen);
    let poly = ribbon_outline(&s, 8);
    assert!(poly.len() > s.samples.len(), "outline has both sides plus caps");
    // the ribbon must be measurably thicker in the middle than at the ends
    let mid = s.samples[s.samples.len() / 2];
    let end = s.samples[1];
    assert!(s.brush.width_for(mid.p) > s.brush.width_for(end.p) * 1.5);
}

#[test]
fn single_sample_stroke_renders_as_a_dot_not_nothing() {
    let mut b = StrokeBuilder::new(1, ToolKind::Pen, [0.0; 3], Brush::default(), false);
    b.push(10.0, 10.0, 0.8, 0.0);
    let s = b.finish(0.0);
    let poly = ribbon_outline(&s, 8);
    assert!(poly.len() > 8, "a tap must still produce a fillable shape");
}

#[test]
fn empty_stroke_is_harmless() {
    let s = Stroke::new(1, ToolKind::Pen, [0.0; 3], Brush::default());
    assert!(ribbon_outline(&s, 8).is_empty());
    assert!(s.bbox().is_none());
}

#[test]
fn warmup_suppresses_the_pen_down_pressure_spike() {
    let mut b = StrokeBuilder::new(1, ToolKind::Pen, [0.0; 3], Brush::default(), false);
    b.push(0.0, 0.0, 1.0, 0.0); // tablet lies on entry
    b.push(1.0, 0.0, 1.0, 4.3);
    b.push(2.0, 0.0, 1.0, 8.6);
    let s = b.finish(0.0);
    assert!(s.samples[0].p < 0.4, "first sample must be clamped, was {}", s.samples[0].p);
    assert!(s.samples[2].p > s.samples[0].p, "pressure must then be allowed to rise");
}

#[test]
fn simplify_keeps_endpoints_and_reduces_points() {
    let s = synth(1, 500.0, 600, ToolKind::Pen);
    let before = s.samples.len();
    let after = simplify(&s.samples, 0.4);
    assert!(after.len() < before, "{} -> {}", before, after.len());
    assert_eq!(after.first().unwrap().x, s.samples.first().unwrap().x);
    assert_eq!(after.last().unwrap().x, s.samples.last().unwrap().x);
    println!("simplify: {before} -> {} points", after.len());
}

#[test]
fn one_euro_smooths_noise_but_tracks_the_signal() {
    let mut f = OneEuro::default();
    let mut out = Vec::new();
    for i in 0..400 {
        let t = i as f64 * 4.3;
        let noise = if i % 2 == 0 { 1.4 } else { -1.4 };
        out.push(f.filter(i as f64 * 0.5 + noise, t));
    }
    // jitter must shrink
    let raw_jitter = 2.8;
    let filt: f64 = out.windows(3).map(|w| (w[1] - (w[0] + w[2]) / 2.0).abs()).sum::<f64>()
        / (out.len() - 2) as f64;
    assert!(filt < raw_jitter / 2.0, "filtered jitter {filt:.3} not much better than raw");
    // and it must still be following the ramp, not stuck
    assert!(out[399] > out[100], "filter lost the signal");
}

// ===========================================================================
// PDF: the three layers
// ===========================================================================

#[test]
fn appending_preserves_the_original_bytes_exactly() {
    let orig = fixture();
    let mut f = PdfFile::open(orig.clone()).unwrap();
    f.write_document(&sample_doc(6), pdf::DEFAULT_GROUP).unwrap();
    let out = f.finish();

    assert!(out.len() > orig.len());
    assert_eq!(&out[..orig.len()], &orig[..], "append-only guarantee violated");
    assert!(out.ends_with(b"%%EOF\n"));
}

#[test]
fn sidecar_survives_the_pdf_round_trip() {
    let mut f = PdfFile::open(fixture()).unwrap();
    let doc = sample_doc(8);
    f.write_document(&doc, pdf::DEFAULT_GROUP).unwrap();
    let out = f.finish();

    match pdf::read_sidecar(&out).unwrap() {
        SidecarStatus::Ok(back) => {
            assert_eq!(back.stroke_count(), doc.stroke_count());
            assert_eq!(back.sample_count(), doc.sample_count());
            assert_eq!(back.device.model, "Huion H640P");
            assert!(!back.device.tilt, "H640P has no tilt; must not be invented");
            assert!(matches!(back.sheets[0].kind, SheetKind::BoundedPage { source_pdf_page: 0 }));
            // Pressure must survive the round trip essentially intact. Asserting
            // a *ratio* against the source rather than an absolute count keeps
            // this honest regardless of how varied the test data happens to be.
            let src = pressure_levels(&doc);
            let got = pressure_levels(&back);
            println!("pressure levels: {src} in -> {got} out");
            assert!(got * 100 >= src * 90, "round trip collapsed pressure: {src} -> {got}");
            assert!(got > 200, "test data too uniform to be meaningful ({got} levels)");
            let kinds: std::collections::HashSet<ToolKind> =
                back.sheets[0].strokes().map(|s| s.kind).collect();
            assert_eq!(kinds.len(), 2, "tool identity lost");
        }
        other => panic!("expected Ok sidecar, got {}", status_name(&other)),
    }
}

#[test]
fn multiple_generations_do_not_duplicate_our_objects() {
    // gen 1
    let mut f = PdfFile::open(fixture()).unwrap();
    let d1 = sample_doc(4);
    f.write_document(&d1, pdf::DEFAULT_GROUP).unwrap();
    let g1 = f.finish();

    // gen 2: user added more strokes
    let mut f = PdfFile::open(g1.clone()).unwrap();
    let mut d2 = sample_doc(9);
    d2.generation = 2;
    f.write_document(&d2, pdf::DEFAULT_GROUP).unwrap();
    let g2 = f.finish();

    assert_eq!(&g2[..g1.len()], &g1[..], "gen 2 must append, not rewrite");

    // The catalog must not accumulate duplicate private keys -- readers pick the
    // FIRST definition, so a duplicate silently serves stale data. We hit this
    // exact bug in the Python proof.
    let occurrences = count(&g2, b"/Inkw_Doc");
    assert_eq!(occurrences, 2, "one /Inkw_Doc per generation, found {occurrences}");

    match pdf::read_sidecar(&g2).unwrap() {
        SidecarStatus::Ok(back) => assert_eq!(
            back.generation, 2,
            "reader must see the NEWEST generation, not the stale first one"
        ),
        other => panic!("expected Ok, got {}", status_name(&other)),
    }
}

#[test]
fn plain_pdf_reports_absent_rather_than_failing() {
    match pdf::read_sidecar(&fixture()).unwrap() {
        SidecarStatus::Absent => {}
        other => panic!("a plain PDF must be Absent, got {}", status_name(&other)),
    }
}

#[test]
fn interop_layer_is_present_for_third_party_readers() {
    let mut f = PdfFile::open(fixture()).unwrap();
    f.write_document(&sample_doc(6), 2).unwrap(); // group=2 -> 3 annots
    let out = f.finish();
    assert_eq!(count(&out, b"/Subtype /Ink"), 3, "expected one annot per group");
    assert_eq!(count(&out, b"/AP <<"), 3, "every annot needs an appearance stream");
    assert!(count(&out, b"/InkList") == 3);
    assert!(count(&out, b"/BM /Multiply") >= 1, "highlighter needs a multiply blend");
    assert!(count(&out, b"/EmbeddedFiles") == 1);
    assert!(count(&out, b"/AFRelationship") == 1);
}

#[test]
fn xref_stream_pdfs_are_refused_not_corrupted() {
    // A minimal PDF whose startxref points at an xref STREAM rather than a table.
    let mut fake = b"%PDF-1.7\n1 0 obj\n<< /Type /XRef /Size 2 /Root 2 0 R >>\nstream\nx\nendstream\nendobj\n".to_vec();
    let off = fake.len();
    fake.extend_from_slice(format!("startxref\n{off}\n%%EOF\n").as_bytes());
    match PdfFile::open(fake) {
        Err(inkwell_core::pdfobj::Error::XrefStream) => {}
        Err(e) => panic!("wrong error: {e}"),
        Ok(_) => panic!("must not silently accept an xref-stream PDF"),
    }
}

// ===========================================================================
// crash safety
// ===========================================================================

#[test]
fn torn_write_recovers_to_the_previous_generation() {
    let mut f = PdfFile::open(fixture()).unwrap();
    f.write_document(&sample_doc(4), pdf::DEFAULT_GROUP).unwrap();
    let g1 = f.finish();

    let mut f = PdfFile::open(g1.clone()).unwrap();
    let mut d2 = sample_doc(9);
    d2.generation = 2;
    f.write_document(&d2, pdf::DEFAULT_GROUP).unwrap();
    let g2 = f.finish();

    // simulate power loss at many points inside generation 2
    for frac in [0.05, 0.25, 0.5, 0.75, 0.95, 0.999] {
        let cut = g1.len() + ((g2.len() - g1.len()) as f64 * frac) as usize;
        let torn = &g2[..cut];
        let rec = pdf::recover_truncated(torn).expect("recovery must find an EOF");
        assert_eq!(rec, &g1[..], "recovery at {frac} did not land on gen 1");
        match pdf::read_sidecar(rec).unwrap() {
            SidecarStatus::Ok(d) => assert_eq!(d.stroke_count(), 4, "gen 1 ink must survive"),
            other => panic!("recovered file unreadable: {}", status_name(&other)),
        }
    }
}

// ===========================================================================
// WAL
// ===========================================================================

#[test]
fn wal_replays_every_intact_record() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("doc.wal");
    let mut w = Wal::open(&p).unwrap();
    let strokes: Vec<Stroke> = (0..12).map(|i| synth(i as u128 + 1, 400.0, 120, ToolKind::Pen)).collect();
    for (i, s) in strokes.iter().enumerate() {
        w.append(&WalEntry::Added { sheet: i % 2, stroke: s.clone() }).unwrap();
    }
    w.append(&WalEntry::Removed(strokes[3].id)).unwrap();
    w.append(&WalEntry::PageInserted { index: 1, width_pt: 595.0, height_pt: 842.0 }).unwrap();

    let back = Wal::replay(&p).unwrap();
    assert_eq!(back.len(), 14);
    match &back[0] {
        WalEntry::Added { sheet, stroke } => {
            assert_eq!(*sheet, 0);
            assert_eq!(stroke.id, strokes[0].id);
        }
        _ => panic!("wrong entry kind"),
    }
    match &back[1] {
        WalEntry::Added { sheet, stroke } => {
            assert_eq!(*sheet, 1);
            assert_eq!(stroke.id, strokes[1].id);
        }
        _ => panic!("wrong entry kind"),
    }
    assert_eq!(back[12], WalEntry::Removed(strokes[3].id));
    assert_eq!(back[13], WalEntry::PageInserted { index: 1, width_pt: 595.0, height_pt: 842.0 });
}

#[test]
fn wal_drops_only_the_torn_final_record() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("doc.wal");
    {
        let mut w = Wal::open(&p).unwrap();
        for i in 0..6 {
            w.append(&WalEntry::Added { sheet: 0, stroke: synth(i as u128 + 1, 400.0, 90, ToolKind::Pen) }).unwrap();
        }
    }
    let full = std::fs::read(&p).unwrap();
    let intact = Wal::replay(&p).unwrap().len();
    assert_eq!(intact, 6);

    // chop bytes off the end: we must always keep 5 of 6, never lose more
    for drop in 1..40 {
        if drop >= full.len() {
            break;
        }
        let torn = &full[..full.len() - drop];
        std::fs::write(&p, torn).unwrap();
        let n = Wal::replay(&p).unwrap().len();
        assert!(n >= 5, "dropping {drop} bytes lost {} records", 6 - n);
        assert!(n <= 6);
    }
}

#[test]
fn wal_truncate_resets_after_a_successful_pdf_write() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("doc.wal");
    let mut w = Wal::open(&p).unwrap();
    w.append(&WalEntry::Added { sheet: 0, stroke: synth(1, 400.0, 50, ToolKind::Pen) }).unwrap();
    assert_eq!(Wal::replay(&p).unwrap().len(), 1);
    w.truncate().unwrap();
    assert_eq!(Wal::replay(&p).unwrap().len(), 0);
}

#[test]
fn wal_replays_all_mutation_types_including_images_text_and_pages() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("all_mutations.wal");
    let mut w = Wal::open(&p).unwrap();

    let stroke = synth(42, 300.0, 80, ToolKind::Highlighter);
    w.append(&WalEntry::Added { sheet: 2, stroke: stroke.clone() }).unwrap();
    w.append(&WalEntry::Removed(42)).unwrap();
    w.append(&WalEntry::PageInserted { index: 1, width_pt: 612.0, height_pt: 792.0 }).unwrap();
    w.append(&WalEntry::PageDeleted { index: 3 }).unwrap();
    w.append(&WalEntry::PageReordered { from_index: 0, to_index: 2 }).unwrap();
    w.append(&WalEntry::PageRotated { index: 1, clockwise: true }).unwrap();
    w.append(&WalEntry::ImageAdded {
        sheet: 0,
        id: "img_test_1".to_string(),
        x: 100.0,
        y: 150.0,
        width: 200.0,
        height: 120.0,
        data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==".to_string(),
    }).unwrap();
    w.append(&WalEntry::ImageRemoved { id: "img_test_1".to_string() }).unwrap();
    w.append(&WalEntry::TextUpsert {
        sheet: 1,
        id: "txt_test_1".to_string(),
        x: 50.0,
        y: 60.0,
        text: "Sample handwritten note".to_string(),
        font_size: 14.0,
        color: "#ff0000".to_string(),
        bold: true,
        italic: false,
        width: 150.0,
        height: 28.0,
    }).unwrap();
    w.append(&WalEntry::TextRemoved { id: "txt_test_1".to_string() }).unwrap();

    let replayed = Wal::replay(&p).unwrap();
    assert_eq!(replayed.len(), 10);
    match &replayed[0] {
        WalEntry::Added { sheet, stroke: s } => {
            assert_eq!(*sheet, 2);
            assert_eq!(s.id, 42);
            assert_eq!(s.kind, ToolKind::Highlighter);
        }
        other => panic!("expected Added, got {other:?}"),
    }
    assert_eq!(replayed[1], WalEntry::Removed(42));
    assert_eq!(replayed[2], WalEntry::PageInserted { index: 1, width_pt: 612.0, height_pt: 792.0 });
    assert_eq!(replayed[3], WalEntry::PageDeleted { index: 3 });
    assert_eq!(replayed[4], WalEntry::PageReordered { from_index: 0, to_index: 2 });
    assert_eq!(replayed[5], WalEntry::PageRotated { index: 1, clockwise: true });
    match &replayed[6] {
        WalEntry::ImageAdded { id, sheet, x, .. } => {
            assert_eq!(id, "img_test_1");
            assert_eq!(*sheet, 0);
            assert_eq!(*x, 100.0);
        }
        other => panic!("expected ImageAdded, got {other:?}"),
    }
    assert_eq!(replayed[7], WalEntry::ImageRemoved { id: "img_test_1".to_string() });
    match &replayed[8] {
        WalEntry::TextUpsert { id, text, bold, .. } => {
            assert_eq!(id, "txt_test_1");
            assert_eq!(text, "Sample handwritten note");
            assert!(*bold);
        }
        other => panic!("expected TextUpsert, got {other:?}"),
    }
    assert_eq!(replayed[9], WalEntry::TextRemoved { id: "txt_test_1".to_string() });
}

#[test]
fn missing_wal_is_not_an_error() {
    assert_eq!(Wal::replay("/nonexistent/path/x.wal").unwrap().len(), 0);
}


// ===========================================================================
// autosave policy
// ===========================================================================

#[test]
fn flush_policy_avoids_hammering_cloud_sync() {
    let p = FlushPolicy::default();
    let dirty = FlushSignals { dirty: true, ..Default::default() };

    // actively writing: do NOT flush
    assert_eq!(p.decide(dirty, 0.5, 5.0), None);
    assert_eq!(p.decide(dirty, 3.0, 19.0), None);
    // user paused
    assert_eq!(p.decide(dirty, 21.0, 30.0), Some(FlushReason::Idle));
    // never let it go too long even while busy
    assert_eq!(p.decide(dirty, 1.0, 200.0), Some(FlushReason::MaxInterval));
    // nothing to save
    assert_eq!(p.decide(FlushSignals::default(), 999.0, 999.0), None);
    // explicit and close always win over idleness
    assert_eq!(
        p.decide(FlushSignals { dirty: true, explicit: true, ..Default::default() }, 0.0, 0.0),
        Some(FlushReason::Explicit)
    );
    assert_eq!(
        p.decide(FlushSignals { dirty: true, closing: true, ..Default::default() }, 0.0, 0.0),
        Some(FlushReason::Closing)
    );
    assert_eq!(
        p.decide(FlushSignals { dirty: true, focus_lost: true, ..Default::default() }, 0.0, 0.0),
        Some(FlushReason::FocusLost)
    );
}

#[test]
fn atomic_write_leaves_no_temp_files_and_replaces_content() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("notes.pdf");
    wal::atomic_write(&target, b"first").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"first");
    wal::atomic_write(&target, b"second-and-longer").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"second-and-longer");

    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("inkwell-tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
}

#[test]
fn pdf_size_remains_compact_for_dense_strokes() {
    let base = fixture();
    let base_len = base.len();
    let mut f = PdfFile::open(base).unwrap();
    let mut doc = Document::for_pdf(1);
    let mut ids = IdGen::seeded(0xC0FFEE);
    for i in 0..100 {
        let kind = if i == 0 { ToolKind::Highlighter } else { ToolKind::Pen };
        let brush = Brush {
            base_width: if kind == ToolKind::Highlighter { 14.0 } else { 2.6 },
            gamma: 1.0,
            ..Default::default()
        };
        let mut b = StrokeBuilder::new(ids.next_id(), kind, [0.1, 0.1, 0.3], brush, true);
        for j in 0..260 {
            let t = j as f64 / 259.0;
            let x = 70.0 + t * 380.0;
            let y = 700.0 - i as f64 * 6.0 + (t * 20.0).sin() * 5.0;
            let p = 0.5 + 0.3 * (t * 10.0).sin();
            b.push(x, y, p, j as f64 * 4.0);
        }
        doc.push_stroke(0, b.finish(0.4));
    }
    f.write_document(&doc, 64).unwrap();
    let final_bytes = f.finish();
    let added_bytes = final_bytes.len() - base_len;
    println!("100 realistic handwritten strokes added only {} bytes ({:.2} KB)", added_bytes, added_bytes as f64 / 1024.0);
    assert!(added_bytes < 75 * 1024, "PDF size inflated: {} bytes added (expected < 75 KB)", added_bytes);
}

// ===========================================================================
// helpers
// ===========================================================================

fn count(hay: &[u8], needle: &[u8]) -> usize {
    let mut n = 0;
    let mut i = 0;
    while let Some(p) = inkwell_core::pdfobj::find(hay, needle, i) {
        n += 1;
        i = p + 1;
    }
    n
}

fn status_name(s: &SidecarStatus) -> String {
    match s {
        SidecarStatus::Ok(_) => "Ok".into(),
        SidecarStatus::Absent => "Absent".into(),
        SidecarStatus::Corrupt(e) => format!("Corrupt({e})"),
        SidecarStatus::Stale(_) => "Stale".into(),
    }
}
