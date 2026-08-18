pub mod images;
pub mod normalise;
pub mod outline;
pub mod rasterizer;
pub mod text;

pub use images::{embed_images_in_pdf, ImageAnnotation};
pub use normalise::normalise;
pub use outline::{extract_outline, TocItem};
pub use rasterizer::PdfiumRasterizer;
pub use text::{extract_text, extract_text_spans, TextSpan};

// Re-export core PDFium types so dependents don't need a direct pdfium_render dependency.
pub use pdfium_render::prelude::{Pdfium, PdfiumError};


/// Initialize PDFium binding by checking absolute paths at executable directory, custom env var, or system library.
pub fn init_pdfium() -> Result<Pdfium, PdfiumError> {
    let mut candidate_paths = Vec::new();

    let mut add_dir_and_subdirs = |p: std::path::PathBuf| {
        candidate_paths.push(p.clone());
        candidate_paths.push(p.join("bin"));
        candidate_paths.push(p.join("src-tauri"));
    };

    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        for _ in 0..6 {
            if let Some(dir) = cur {
                add_dir_and_subdirs(dir.to_path_buf());
                cur = dir.parent();
            } else {
                break;
            }
        }
    }

    if let Ok(custom_dir) = std::env::var("PDFIUM_DLL_DIR") {
        let p = std::path::PathBuf::from(custom_dir);
        add_dir_and_subdirs(p);
    }

    for dir in candidate_paths {
        let dll_path = dir.join("pdfium.dll");
        if dll_path.exists() {
            let lib_name = Pdfium::pdfium_platform_library_name_at_path(&dir);
            match Pdfium::bind_to_library(&lib_name) {
                Ok(bindings) => {
                    eprintln!("Successfully loaded PDFium library from {:?}", dll_path);
                    return Ok(Pdfium::new(bindings));
                }
                Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                    return Ok(Pdfium::default());
                }
                Err(error) => eprintln!("Failed to load PDFium from {dll_path:?}: {error:?}"),
            }
        }
    }

    match Pdfium::bind_to_system_library() {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => Ok(Pdfium::default()),
        Err(e) => Err(e),
    }
}
