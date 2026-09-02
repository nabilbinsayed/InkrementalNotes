use inkwell_pdf::{init_pdfium, normalise, extract_text, PdfiumRasterizer};
use inkwell_core::pdf::PdfFile;
use inkwell_core::tiles::PageRasterizer;
use std::path::PathBuf;

fn get_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/lecture.pdf")
}

#[test]
fn test_fixture_file_exists() {
    let path = get_fixture_path();
    assert!(path.exists(), "lecture.pdf fixture should exist at {:?}", path);
}

#[test]
fn test_classic_xref_pdf_opens_with_pdf_file() {
    let path = get_fixture_path();
    let bytes = std::fs::read(&path).expect("read fixture");
    let pdf = PdfFile::open(bytes);
    assert!(pdf.is_ok(), "Classic xref PDF should open cleanly in PdfFile::open");
}

static PDFIUM_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn test_pdfium_integration_or_graceful_skip() {
    let _lock = PDFIUM_TEST_LOCK.lock().unwrap();
    let path = get_fixture_path();
    let bytes = std::fs::read(&path).expect("read fixture");
    
    match init_pdfium() {
        Ok(pdfium) => {
            // Normalise test
            let norm_bytes = normalise(&pdfium, &bytes).expect("normalise should succeed");
            assert!(PdfFile::open(norm_bytes).is_ok(), "Normalised bytes must open in PdfFile");
            
            // Text extraction test
            let doc = pdfium.load_pdf_from_byte_slice(&bytes, None).expect("load pdf");
            let text = extract_text(&doc, 0).expect("extract text page 0");
            assert!(text.contains("Fourier Series"), "Extracted text should contain 'Fourier Series'");
            
            // Rasterizer test
            let rasterizer = PdfiumRasterizer::new(doc);
            let size = rasterizer.page_size_pt(0);
            assert!(size.is_some(), "Page size pt should be valid");
            
            let (page_w, page_h) = size.unwrap();
            let tile = rasterizer.rasterize(0, [0.0, 0.0, page_w, page_h], 256);
            assert!(tile.is_some(), "Tile rasterize should produce 256x256 tile");
            let t = tile.unwrap();
            assert_eq!(t.w.max(t.h), 256);
            assert_eq!(t.data.len(), (t.w * t.h * 3) as usize);
            assert!(
                t.data.chunks_exact(3).any(|rgb| rgb != [255, 255, 255]),
                "A text-bearing fixture must not rasterize to an all-white tile"
            );

            // Test inserting a blank page
            use pdfium_render::prelude::*;
            let mut mut_doc = pdfium.load_pdf_from_byte_slice(&bytes, None).expect("load for insert");
            let initial_count = mut_doc.pages().len();
            let new_page = mut_doc.pages_mut().create_page_at_index(
                PdfPagePaperSize::Custom(PdfPoints::new(595.0), PdfPoints::new(842.0)),
                initial_count,
            );
            println!("create_page_at_index result: {:?}", new_page.is_ok());
            assert!(new_page.is_ok(), "create_page_at_index should succeed: {:?}", new_page.err());
            let saved = mut_doc.save_to_bytes();
            println!("save_to_bytes result: {:?}", saved.is_ok());
            assert!(saved.is_ok(), "save_to_bytes should succeed: {:?}", saved.err());
            let new_bytes = saved.unwrap();
            
            let reloaded = pdfium.load_pdf_from_byte_slice(&new_bytes, None).expect("reload");
            assert_eq!(reloaded.pages().len(), initial_count + 1, "Page count should increase by 1");
            
            let parsed = PdfFile::open(new_bytes.clone());
            println!("PdfFile::open after insert: {:?}", parsed.as_ref().map(|p| p.page_count()));
        }
        Err(e) => {
            eprintln!("PDFium library not available at runtime ({:?}); skipping live PDFium render tests.", e);
        }
    }
}

#[test]
fn test_extract_outline() {
    let _lock = PDFIUM_TEST_LOCK.lock().unwrap();
    let pdfium = match init_pdfium() {
        Ok(p) => p,
        Err(_) => return,
    };
    let fixture_path = get_fixture_path();
    let bytes = std::fs::read(fixture_path).expect("read lecture.pdf");
    let doc = pdfium.load_pdf_from_byte_slice(&bytes, None).expect("load lecture.pdf");
    let outline = inkwell_pdf::extract_outline(&doc);
    println!("Extracted outline items: {}", outline.len());
}

#[test]
fn test_insert_blank_page_draw_and_save_multi_page() {
    let _lock = PDFIUM_TEST_LOCK.lock().unwrap();
    let pdfium = match init_pdfium() {
        Ok(p) => p,
        Err(_) => return, // Gracefully skip if pdfium.dll not present
    };

    let fixture_path = get_fixture_path();
    let original_bytes = std::fs::read(fixture_path).expect("read lecture.pdf");

    // 1. Initial 1-page document
    let mut doc = inkwell_core::Document::for_pdf(1);
    assert_eq!(doc.sheets.len(), 1);

    // 2. Insert blank page at index 1
    doc.insert_sheet(1);
    assert_eq!(doc.sheets.len(), 2);

    let mut pdf_doc = pdfium.load_pdf_from_byte_slice(&original_bytes, None).expect("load pdf");
    assert_eq!(pdf_doc.pages().len(), 1);
    pdf_doc.pages_mut().create_page_at_index(
        pdfium_render::prelude::PdfPagePaperSize::Custom(
            pdfium_render::prelude::PdfPoints::new(595.0),
            pdfium_render::prelude::PdfPoints::new(842.0),
        ),
        1,
    ).expect("create blank page");
    let updated_base_bytes = pdf_doc.save_to_bytes().expect("save base with blank page");
    drop(pdf_doc);

    // 3. User draws stroke on Page 2 (sheet index 1)
    let stroke = inkwell_core::Stroke {
        id: 9999,
        kind: inkwell_core::ToolKind::Pen,
        brush: inkwell_core::Brush {
            base_width: 3.0,
            min_ratio: 0.22,
            gamma: 1.0,
        },
        rgb: [0.0, 0.0, 0.8],
        samples: vec![
            inkwell_core::Sample::new(100.0, 100.0, 0.5, 0.0),
            inkwell_core::Sample::new(150.0, 150.0, 0.5, 10.0),
            inkwell_core::Sample::new(200.0, 200.0, 0.5, 20.0),
        ],
    };
    doc.push_stroke(1, stroke);
    assert_eq!(doc.sheets[0].stroke_count(), 0);
    assert_eq!(doc.sheets[1].stroke_count(), 1);

    // 4. Save document
    let mut pdf_file = PdfFile::open(updated_base_bytes).expect("open updated base");
    assert_eq!(pdf_file.page_count(), 2);
    pdf_file.write_document(&doc, inkwell_core::pdf::DEFAULT_GROUP).expect("write document");
    let final_bytes = pdf_file.finish();

    // 5. Verify saved PDF
    let verify_pdf = pdfium.load_pdf_from_byte_slice(&final_bytes, None).expect("load saved pdf");
    assert_eq!(verify_pdf.pages().len(), 2, "Saved PDF must have exactly 2 pages");
    drop(verify_pdf);

    // 6. Verify sidecar
    match inkwell_core::pdf::read_sidecar(&final_bytes) {
        Ok(inkwell_core::SidecarStatus::Ok(saved_doc)) => {
            assert_eq!(saved_doc.sheets.len(), 2, "Sidecar must preserve 2 sheets");
            assert_eq!(saved_doc.sheets[0].stroke_count(), 0, "Page 1 must have 0 strokes");
            assert_eq!(saved_doc.sheets[1].stroke_count(), 1, "Page 2 must have 1 stroke");
        }
        _ => panic!("Unexpected sidecar status"),
    }
}

#[test]
fn test_unicode_search_window_slicing_safety() {
    let bangla_text = "অধ্যায় ৩: ত্রিকোণমিতি এবং ক্যালকুলাস 🧑‍🔬 ∑_{i=0}^∞ a_i x^i = e^x গণিত ও পদার্থবিজ্ঞান";
    let q = "ত্রিকোণমিতি";
    let q_lower = q.to_lowercase();
    let q_chars: Vec<char> = q_lower.chars().collect();

    let text_chars: Vec<char> = bangla_text.chars().collect();
    let text_lower: String = text_chars.iter().collect::<String>().to_lowercase();
    let text_lower_chars: Vec<char> = text_lower.chars().collect();

    let found_pos = text_lower_chars.windows(q_chars.len()).position(|w| w == q_chars.as_slice());
    assert!(found_pos.is_some(), "Must locate Bangla search query");

    let char_idx = found_pos.unwrap();
    let start = char_idx.saturating_sub(40).min(text_chars.len());
    let end = (char_idx + q_chars.len() + 40).min(text_chars.len()).max(start);
    let snippet_str: String = text_chars[start..end].iter().collect();
    let snippet = format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        snippet_str.replace('\n', " "),
        if end < text_chars.len() { "…" } else { "" }
    );
    assert!(snippet.contains("ত্রিকোণমিতি"));
}

#[test]
fn test_color_fidelity() {
    let _lock = PDFIUM_TEST_LOCK.lock().unwrap();
    let pdfium = match init_pdfium() {
        Ok(p) => p,
        Err(_) => return, // Gracefully skip if runtime environment lacks pdfium binary
    };

    // 1. Check direct PDFium render of vector shapes
    let mut doc = pdfium.create_new_pdf().expect("create new pdf");
    let mut page = doc.pages_mut().create_page_at_index(
        pdfium_render::prelude::PdfPagePaperSize::Custom(
            pdfium_render::prelude::PdfPoints::new(100.0),
            pdfium_render::prelude::PdfPoints::new(100.0),
        ),
        0,
    ).expect("create page");

    // Add a solid blue rectangle using PDF page path object
    use pdfium_render::prelude::*;
    let path = PdfPagePathObject::new_rect(
        &doc,
        PdfRect::new(
            PdfPoints::new(0.0),
            PdfPoints::new(0.0),
            PdfPoints::new(100.0),
            PdfPoints::new(100.0),
        ),
        None,
        None,
        Some(PdfColor::new(15, 23, 42, 255)), // Fill color: R=15, G=23, B=42
    ).expect("create rect path");
    page.objects_mut().add_path_object(path).expect("add path");
    let vector_pdf_bytes = doc.save_to_bytes().expect("save vector pdf");

    // Render vector PDF
    let doc_v = pdfium.load_pdf_from_byte_slice(&vector_pdf_bytes, None).expect("load vector pdf");
    let page_v = doc_v.pages().get(0).expect("get page");
    let config = PdfRenderConfig::new().set_target_width(50).set_maximum_height(50);
    let bitmap_v = page_v.render_with_config(&config).expect("render vector page");
    println!("Vector page bitmap format: {:?}", bitmap_v.format());
    let raw_v = bitmap_v.as_raw_bytes();
    println!("Vector page first 4 raw bytes: {:?}", &raw_v[0..4]);
    // Format could be BGRA -> [B, G, R, A] or RGBA -> [R, G, B, A]

    // 2. Check DynamicImage -> PdfPageImageObject embedding
    let mut img_buf = image::RgbaImage::new(50, 50);
    for pixel in img_buf.pixels_mut() {
        *pixel = image::Rgba([15, 23, 42, 255]); // #0f172a (R=15, G=23, B=42)
    }
    let dyn_img = image::DynamicImage::ImageRgba8(img_buf);
    let mut doc_img = pdfium.create_new_pdf().expect("create new pdf");
    let mut page_img = doc_img.pages_mut().create_page_at_index(
        PdfPagePaperSize::Custom(
            PdfPoints::new(100.0),
            PdfPoints::new(100.0),
        ),
        0,
    ).expect("create page");
    let mut img_obj = PdfPageImageObject::new(&doc_img, &dyn_img).expect("create image obj");
    img_obj.scale(100.0, 100.0).expect("scale");
    img_obj.translate(PdfPoints::new(0.0), PdfPoints::new(0.0)).expect("translate");
    page_img.objects_mut().add_image_object(img_obj).expect("add img obj");
    let img_pdf_bytes = doc_img.save_to_bytes().expect("save img pdf");

    // 3. Test PdfiumRasterizer on the vector and image docs
    let rasterizer_v = PdfiumRasterizer::new(doc_v);
    let tile_v = rasterizer_v.rasterize(0, [0.0, 0.0, 100.0, 100.0], 50).expect("rasterize vector");
    println!("Rasterized vector RGB: ({}, {}, {})", tile_v.data[0], tile_v.data[1], tile_v.data[2]);

    let doc_i = pdfium.load_pdf_from_byte_slice(&img_pdf_bytes, None).expect("load img pdf");
    let rasterizer_i = PdfiumRasterizer::new(doc_i);
    let tile_i = rasterizer_i.rasterize(0, [0.0, 0.0, 100.0, 100.0], 50).expect("rasterize image");
    println!("Rasterized image RGB: ({}, {}, {})", tile_i.data[0], tile_i.data[1], tile_i.data[2]);

    assert_eq!((tile_v.data[0], tile_v.data[1], tile_v.data[2]), (15, 23, 42), "Vector fill color must be (15, 23, 42)");
    assert_eq!((tile_i.data[0], tile_i.data[1], tile_i.data[2]), (15, 23, 42), "Image color must be (15, 23, 42)");
}

#[test]
fn saved_sticky_note_survives_round_trip() {
    let _lock = PDFIUM_TEST_LOCK.lock().unwrap();
    let pdfium = match init_pdfium() {
        Ok(p) => p,
        Err(_) => return,
    };

    let fixture_path = get_fixture_path();
    let original_bytes = std::fs::read(&fixture_path).expect("read fixture");

    let note = inkwell_pdf::TextAnnotation {
        sheet: 0,
        x: 100.0,
        y: 100.0,
        text: "InkWell note sticky text".to_string(),
        font_size: 16.0,
        color: "#141724".to_string(),
        bold: false,
        italic: false,
    };

    let embedded_bytes = inkwell_pdf::embed_texts_in_pdf(&pdfium, &original_bytes, &[note])
        .expect("embed_texts_in_pdf should succeed");

    assert!(PdfFile::open(embedded_bytes.clone()).is_ok(), "Embedded PDF must open cleanly in PdfFile");

    let doc = pdfium.load_pdf_from_byte_slice(&embedded_bytes, None).expect("load embedded PDF");
    let extracted = extract_text(&doc, 0).expect("extract text from page 0");
    assert!(
        extracted.contains("InkWell note sticky text"),
        "Extracted text should contain the embedded sticky note text"
    );
}









