use inkwell_core::codec::{self, CodecError, MAGIC, VERSION};
use inkwell_core::pdfobj::skip_value;
use std::path::{PathBuf, Component};

// ===========================================================================
// 1. Adversarial Varints and Codec Bounds
// ===========================================================================

#[test]
fn test_varint_shift_overflow_and_bit63_saturation() {
    // 10-byte varint where all bytes have MSB set
    let bad_10_bytes = [0x80; 10];
    let mut pos = 0;
    assert!(matches!(codec::get_uvarint(&bad_10_bytes, &mut pos), Err(CodecError::Truncated)));
    assert_eq!(pos, 10);

    // 11-byte varint
    let bad_11_bytes = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01];
    let mut pos = 0;
    assert!(matches!(codec::get_uvarint(&bad_11_bytes, &mut pos), Err(CodecError::Truncated)));

    // Shift == 63 with valid payload (0 or 1)
    let valid_shift63_zero = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00];
    let mut pos = 0;
    assert!(codec::get_uvarint(&valid_shift63_zero, &mut pos).is_ok());

    let valid_shift63_one = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01];
    let mut pos = 0;
    assert_eq!(codec::get_uvarint(&valid_shift63_one, &mut pos).unwrap(), 1u64 << 63);

    // Shift == 63 with invalid payload (2..127) -> bit overflow in u64
    for b in 2u8..=0x7F {
        let invalid_shift63 = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, b];
        let mut pos = 0;
        assert!(
            matches!(codec::get_uvarint(&invalid_shift63, &mut pos), Err(CodecError::Truncated)),
            "payload byte {b} at shift 63 must be rejected"
        );
    }
}

#[test]
fn test_varint_truncated_buffers() {
    let mut pos = 0;
    assert!(matches!(codec::get_uvarint(&[], &mut pos), Err(CodecError::Truncated)));

    for len in 1..9 {
        let truncated = vec![0x80; len];
        let mut pos = 0;
        assert!(
            matches!(codec::get_uvarint(&truncated, &mut pos), Err(CodecError::Truncated)),
            "buffer of length {len} with continuous 0x80 must error as truncated"
        );
    }
}

#[test]
fn test_codec_decode_oversized_stroke_count_and_bounded_allocation() {
    // Construct a payload with valid MAGIC, VERSION, and u64::MAX stroke count
    let mut bad_payload = Vec::new();
    bad_payload.extend_from_slice(MAGIC); // MAGIC
    bad_payload.push(VERSION); // VERSION
    codec::put_uvarint(&mut bad_payload, u64::MAX); // Count = 18446744073709551615
    // Payload abruptly ends after count

    let res = codec::decode(&bad_payload);
    assert!(matches!(res, Err(CodecError::Truncated)));

    // Construct a payload with count = 1_000_000_000
    let mut bad_payload2 = Vec::new();
    bad_payload2.extend_from_slice(MAGIC);
    bad_payload2.push(VERSION);
    codec::put_uvarint(&mut bad_payload2, 1_000_000_000);

    let res2 = codec::decode(&bad_payload2);
    assert!(matches!(res2, Err(CodecError::Truncated)));
}

#[test]
fn test_codec_decode_oversized_sample_count_and_bounded_allocation() {
    // Construct a payload with 1 stroke, but stroke sample count = u64::MAX
    let mut bad_payload = Vec::new();
    bad_payload.extend_from_slice(MAGIC);
    bad_payload.push(VERSION);
    codec::put_uvarint(&mut bad_payload, 1); // 1 stroke
    bad_payload.extend_from_slice(&[0u8; 16]); // ID (16 bytes)
    bad_payload.push(1); // ToolKind::Pen
    bad_payload.extend_from_slice(&[0u8; 3]); // RGB (3 bytes)
    codec::put_uvarint(&mut bad_payload, 100); // base_width
    codec::put_uvarint(&mut bad_payload, 1000); // gamma
    codec::put_uvarint(&mut bad_payload, 200); // min_ratio
    codec::put_uvarint(&mut bad_payload, u64::MAX); // Sample count = u64::MAX

    let res = codec::decode(&bad_payload);
    assert!(matches!(res, Err(CodecError::Truncated)));
}

#[test]
fn test_varint_zigzag_roundtrip_extremes() {
    for val in [i64::MIN, i64::MIN + 1, -1000000, -1, 0, 1, 1000000, i64::MAX - 1, i64::MAX] {
        let mut buf = Vec::new();
        codec::put_varint(&mut buf, val);
        let mut pos = 0;
        let decoded = codec::get_varint(&buf, &mut pos).expect("decode varint");
        assert_eq!(decoded, val, "zigzag roundtrip failed for {val}");
        assert_eq!(pos, buf.len());
    }
}

// ===========================================================================
// 2. Adversarial PDF Object Token and Slicing Bounds
// ===========================================================================

#[test]
fn test_pdfobj_skip_value_fuzzing_and_clamp() {
    let adversarial_cases: &[&[u8]] = &[
        b"",
        b"<",
        b"<<",
        b"<<<",
        b">>>",
        b"(",
        b"((((",
        b"()()(((",
        b"(\\",
        b"(\\\\",
        b"(\\\\",
        b"[",
        b"[[[[",
        b"[/ / /",
        b"/",
        b"//",
        b"///",
        b"<< /A (unterminated string",
        b"<< /Nested << /Deeper << /Unclosed 123",
        b"[ << /Key (val) >> <ABC 123 ]",
        b"123 0 R",
        b"123",
        b"   ",
        b"\x00\xFF\xFE\xFD",
    ];

    for &input in adversarial_cases {
        let end = skip_value(input, 0);
        assert!(
            end <= input.len(),
            "skip_value must clamp to input.len() (len={}, returned={}) for input {:?}",
            input.len(),
            end,
            String::from_utf8_lossy(input)
        );
    }
}

// ===========================================================================
// 3. Path Traversal Validation Logic Oracle
// ===========================================================================

fn validate_save_path(p: &str) -> Result<PathBuf, String> {
    let normalized = p.replace('\\', "/");
    let path = PathBuf::from(&normalized);
    if p.contains("..") || path.components().any(|c| c == Component::ParentDir) {
        return Err("Path traversal components (..) are not permitted in save path".to_string());
    }
    let is_pdf = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf {
        return Err("Invalid save path: destination file must have a .pdf extension".to_string());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("Parent directory does not exist: {parent:?}"));
        }
    }
    Ok(PathBuf::from(p))
}

#[test]
fn test_path_traversal_fuzzing_matrix() {
    let rejection_cases = &[
        "../../foo.pdf",
        "../foo.pdf",
        "foo/../../bar.pdf",
        "C:\\..\\evil.pdf",
        "..\\..\\payload.pdf",
        "subdir/../../../secret.pdf",
        ".",
        "/",
        "",
        "foo",
        "foo.txt",
        "foo.pdf.exe",
        "foo.pdf.png",
        "foo.pdf.",
        "C:\\non_existent_folder_987654321\\output.pdf",
        "/non_existent_root_dir_12345/doc.pdf",
    ];

    for &bad_path in rejection_cases {
        let res = validate_save_path(bad_path);
        assert!(
            res.is_err(),
            "Expected bad path '{bad_path}' to be rejected, but got Ok({:?})",
            res.ok()
        );
    }

    // Valid paths
    let temp_dir = tempfile::tempdir().unwrap();
    let valid_file = temp_dir.path().join("output.pdf");
    assert!(validate_save_path(valid_file.to_str().unwrap()).is_ok());

    let valid_file_upper = temp_dir.path().join("OUTPUT.PDF");
    assert!(validate_save_path(valid_file_upper.to_str().unwrap()).is_ok());

    let valid_file_mixed = temp_dir.path().join("Notes_2026.Pdf");
    assert!(validate_save_path(valid_file_mixed.to_str().unwrap()).is_ok());
}

// ===========================================================================
// 4. Dimension Bounds Validation Logic Oracle
// ===========================================================================

fn validate_dimensions(w: f64, h: f64) -> Result<(), String> {
    if !w.is_finite() || !h.is_finite() || w < 72.0 || h < 72.0 || w > 14400.0 || h > 14400.0 {
        return Err(format!("Invalid page dimensions: {w} x {h} pt (must be between 72 and 14400)"));
    }
    Ok(())
}

#[test]
fn test_dimension_bounds_fuzzing_matrix() {
    let invalid_dimensions: &[(f64, f64)] = &[
        (f64::NAN, 500.0),
        (500.0, f64::NAN),
        (f64::INFINITY, 500.0),
        (500.0, f64::INFINITY),
        (f64::NEG_INFINITY, 500.0),
        (500.0, f64::NEG_INFINITY),
        (-100.0, 500.0),
        (500.0, -100.0),
        (-0.0, 500.0),
        (0.0, 0.0),
        (0.001, 500.0),
        (71.9999, 500.0),
        (500.0, 71.9999),
        (14400.001, 500.0),
        (500.0, 14400.001),
        (1e9, 1e9),
        (1e308, 1e308),
    ];

    for &(w, h) in invalid_dimensions {
        assert!(
            validate_dimensions(w, h).is_err(),
            "Dimension ({w}, {h}) must be rejected"
        );
    }

    let valid_dimensions: &[(f64, f64)] = &[
        (72.0, 72.0),         // 1x1 inch minimum
        (595.28, 841.89),     // A4 standard
        (612.0, 792.0),       // US Letter standard
        (14400.0, 14400.0),   // 200x200 inches maximum
    ];

    for &(w, h) in valid_dimensions {
        assert!(
            validate_dimensions(w, h).is_ok(),
            "Valid dimension ({w}, {h}) must be accepted"
        );
    }
}
