pub mod normalise;
pub mod rasterizer;
pub mod text;

pub use normalise::normalise;
pub use rasterizer::PdfiumRasterizer;
pub use text::extract_text;

use pdfium_render::prelude::*;

/// Initialize PDFium binding by looking in local path, parent path, or system library.
pub fn init_pdfium() -> Result<Pdfium, PdfiumError> {
    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
        .or_else(|_| Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("../")))
        .or_else(|_| Pdfium::bind_to_system_library())?;
    Ok(Pdfium::new(bindings))
}
