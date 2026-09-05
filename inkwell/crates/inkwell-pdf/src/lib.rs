pub mod images;
pub mod normalise;
pub mod outline;
pub mod rasterizer;
pub mod text;
pub mod text_embed;

pub use images::{embed_images_in_pdf, ImageAnnotation};
pub use normalise::normalise;
pub use outline::{extract_outline, TocItem};
pub use rasterizer::PdfiumRasterizer;
pub use text::{extract_text, extract_text_spans, extract_page_text_data, TextSpan, CharSpan, TextLine, PageTextData};
pub use text_embed::{embed_texts_in_pdf, TextAnnotation};

// Re-export core PDFium types so dependents don't need a direct pdfium_render dependency.
pub use pdfium_render::prelude::{Pdfium, PdfiumError};


#[cfg(target_os = "windows")]
const PDFIUM_FILENAMES: &[&str] = &["pdfium.dll"];

#[cfg(target_os = "linux")]
const PDFIUM_FILENAMES: &[&str] = &["libpdfium.so", "libpdfium.so.1"];

#[cfg(target_os = "macos")]
const PDFIUM_FILENAMES: &[&str] = &["libpdfium.dylib"];

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
const PDFIUM_FILENAMES: &[&str] = &["pdfium.dll", "libpdfium.so", "libpdfium.dylib"];

/// Initialize PDFium binding by checking absolute paths at executable directory, custom env var, or system library.
pub fn init_pdfium() -> Result<Pdfium, PdfiumError> {
    let mut candidate_paths = Vec::new();

    let mut add_dir_and_subdirs = |p: std::path::PathBuf| {
        candidate_paths.push(p.clone());
        candidate_paths.push(p.join("bin"));
        candidate_paths.push(p.join("lib"));
        candidate_paths.push(p.join("lib64"));
        candidate_paths.push(p.join("src-tauri"));
        candidate_paths.push(p.join("resources"));
        candidate_paths.push(p.join("resources").join("bin"));
        candidate_paths.push(p.join("resources").join("lib"));
        candidate_paths.push(p.join("lib").join("Inkwell"));
        candidate_paths.push(p.join("lib").join("inkwell"));
        candidate_paths.push(p.join("lib").join("Inkwell").join("resources"));
        candidate_paths.push(p.join("lib").join("Inkwell").join("resources").join("bin"));
        candidate_paths.push(p.join("_up_").join("_up_").join("bin"));
        candidate_paths.push(p.join("resources").join("_up_").join("_up_").join("bin"));
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

    if let Ok(cwd) = std::env::current_dir() {
        add_dir_and_subdirs(cwd.clone());
        if let Some(parent) = cwd.parent() {
            add_dir_and_subdirs(parent.to_path_buf());
        }
    }

    if let Ok(custom_dir) = std::env::var("PDFIUM_DLL_DIR") {
        let p = std::path::PathBuf::from(custom_dir);
        add_dir_and_subdirs(p);
    }

    for dir in candidate_paths {
        for filename in PDFIUM_FILENAMES {
            let lib_path = dir.join(filename);
            if lib_path.exists() {
                match Pdfium::bind_to_library(&lib_path) {
                    Ok(bindings) => {
                        eprintln!("Successfully loaded PDFium library from {:?}", lib_path);
                        return Ok(Pdfium::new(bindings));
                    }
                    Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                        return Ok(Pdfium::default());
                    }
                    Err(error) => eprintln!("Failed to load PDFium from {lib_path:?}: {error:?}"),
                }
            }
        }
    }

    match Pdfium::bind_to_system_library() {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => Ok(Pdfium::default()),
        Err(e) => Err(e),
    }
}

/// Initialize PDFium binding by probing a specific directory and its standard subdirectories.
pub fn init_pdfium_from_dir(dir: &std::path::Path) -> Result<Pdfium, PdfiumError> {
    let candidate_paths = [
        dir.to_path_buf(),
        dir.join("bin"),
        dir.join("lib"),
        dir.join("lib64"),
        dir.join("resources"),
        dir.join("resources").join("bin"),
        dir.join("resources").join("lib"),
        dir.join("_up_").join("_up_").join("bin"),
        dir.join("resources").join("_up_").join("_up_").join("bin"),
    ];

    for d in &candidate_paths {
        for filename in PDFIUM_FILENAMES {
            let lib_path = d.join(filename);
            if lib_path.exists() {
                match Pdfium::bind_to_library(&lib_path) {
                    Ok(bindings) => {
                        eprintln!("Successfully loaded PDFium library from {:?}", lib_path);
                        return Ok(Pdfium::new(bindings));
                    }
                    Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                        return Ok(Pdfium::default());
                    }
                    Err(error) => eprintln!("Failed to load PDFium from {lib_path:?}: {error:?}"),
                }
            }
        }
    }

    Pdfium::bind_to_library(dir.join(PDFIUM_FILENAMES[0])).map(Pdfium::new)
}

