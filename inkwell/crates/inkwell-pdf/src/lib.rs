pub mod normalise;
pub mod rasterizer;
pub mod text;

pub use normalise::normalise;
pub use rasterizer::PdfiumRasterizer;
pub use text::extract_text;

use pdfium_render::prelude::*;

/// Initialize PDFium binding by checking absolute paths at executable directory, CWD, parent paths, or system library.
pub fn init_pdfium() -> Result<Pdfium, PdfiumError> {
    let mut candidate_paths = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidate_paths.push(parent.to_path_buf());
            if let Some(grandparent) = parent.parent() {
                candidate_paths.push(grandparent.to_path_buf());
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidate_paths.push(cwd.clone());
        candidate_paths.push(cwd.join("bin"));
        if let Some(parent) = cwd.parent() {
            candidate_paths.push(parent.to_path_buf());
            candidate_paths.push(parent.join("bin"));
            if let Some(grandparent) = parent.parent() {
                candidate_paths.push(grandparent.to_path_buf());
                candidate_paths.push(grandparent.join("bin"));
            }
        }
    }

    for dir in candidate_paths {
        let dll_path = dir.join("pdfium.dll");
        if dll_path.exists() {
            let lib_name = Pdfium::pdfium_platform_library_name_at_path(&dir);
            match Pdfium::bind_to_library(&lib_name) {
                Ok(bindings) => return Ok(Pdfium::new(bindings)),
                Err(error) => eprintln!("Failed to load PDFium from {dll_path:?}: {error:?}"),
            }
        }
    }

    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
        .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("../")))
        .or_else(|_| Pdfium::bind_to_system_library())?;
    Ok(Pdfium::new(bindings))
}
