pub mod normalise;
pub mod rasterizer;
pub mod text;

pub use normalise::normalise;
pub use rasterizer::PdfiumRasterizer;
pub use text::extract_text;

// Re-export core PDFium types so dependents don't need a direct pdfium_render dependency.
pub use pdfium_render::prelude::{Pdfium, PdfiumError};


/// Initialize PDFium binding by checking absolute paths at executable directory, CWD, parent paths, or system library.
pub fn init_pdfium() -> Result<Pdfium, PdfiumError> {
    let mut candidate_paths = Vec::new();

    let mut add_dir_and_subdirs = |p: std::path::PathBuf| {
        candidate_paths.push(p.clone());
        candidate_paths.push(p.join("bin"));
        candidate_paths.push(p.join("src-tauri"));
    };

    if let Ok(exe) = std::env::current_exe() {
        let mut curr = exe.parent().map(|p| p.to_path_buf());
        let mut depth = 0;
        while let Some(dir) = curr {
            add_dir_and_subdirs(dir.clone());
            curr = dir.parent().map(|p| p.to_path_buf());
            depth += 1;
            if depth > 8 { break; }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut curr = Some(cwd);
        let mut depth = 0;
        while let Some(dir) = curr {
            add_dir_and_subdirs(dir.clone());
            curr = dir.parent().map(|p| p.to_path_buf());
            depth += 1;
            if depth > 8 { break; }
        }
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
                Err(error) => eprintln!("Failed to load PDFium from {dll_path:?}: {error:?}"),
            }
        }
    }

    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
        .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("../")))
        .or_else(|_| Pdfium::bind_to_system_library())?;
    Ok(Pdfium::new(bindings))
}
