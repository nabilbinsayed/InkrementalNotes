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

#[test]
fn test_pdfium_integration_or_graceful_skip() {
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
        }
        Err(e) => {
            eprintln!("PDFium library not available at runtime ({:?}); skipping live PDFium render tests.", e);
        }
    }
}
