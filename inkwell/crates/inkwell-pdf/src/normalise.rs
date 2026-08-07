use inkwell_core::pdfobj::{PdfFile, Error as PdfObjError};
use pdfium_render::prelude::*;
use log::debug;

#[derive(Debug)]
pub enum NormaliseError {
    PdfiumInit,
    PdfiumLoad,
    PdfiumSave,
    ParseFailed(PdfObjError),
}

/// Normalise a PDF into a form that `inkwell_core::pdfobj` can parse.
///
/// Most real-world PDFs use cross-reference streams and object streams
/// (PDF 1.5+). Our byte-level reader (`pdfobj`) handles only classic
/// cross-reference tables. PDFium can decompress and re-serialise any
/// PDF into that simpler form.
///
/// If the input already uses classic xref, this function returns it
/// unchanged (avoiding a needless PDFium round-trip).
pub fn normalise(pdfium: &Pdfium, input: &[u8]) -> Result<Vec<u8>, NormaliseError> {
    // 1. First try opening with our parser
    match PdfFile::open(input.to_vec()) {
        Ok(_) => {
            debug!("PDF is already in classic xref format.");
            return Ok(input.to_vec());
        }
        Err(PdfObjError::XrefStream) => {
            debug!("PDF uses xref stream. Normalising with PDFium...");
        }
        Err(e) => {
            // Some other parsing error, might still be fixed by normalising
            debug!("PDF parsing failed ({:?}). Normalising with PDFium...", e);
        }
    }

    // 2. Load with PDFium
    let doc = pdfium.load_pdf_from_byte_slice(input, None).map_err(|_| NormaliseError::PdfiumLoad)?;

    // 3. Save back (this re-serialises to classic xref by default)
    let output = doc.save_to_bytes().map_err(|_| NormaliseError::PdfiumSave)?;

    // 4. Verify output
    match PdfFile::open(output.clone()) {
        Ok(_) => Ok(output),
        Err(e) => Err(NormaliseError::ParseFailed(e)),
    }
}
