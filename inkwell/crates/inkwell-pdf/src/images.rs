use pdfium_render::prelude::*;
use std::io::Cursor;
use base64::Engine;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImageAnnotation {
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub data_url: String,
}

/// Embed a list of images into the PDF pages using PDFium.
pub fn embed_images_in_pdf(
    pdfium: &Pdfium,
    pdf_bytes: &[u8],
    images: &[ImageAnnotation],
) -> Result<Vec<u8>, PdfiumError> {
    if images.is_empty() {
        return Ok(pdf_bytes.to_vec());
    }

    let doc = pdfium.load_pdf_from_byte_slice(pdf_bytes, None)?;

    for img in images {
        if img.width <= 0.0 || img.height <= 0.0 {
            continue;
        }

        // Extract raw bytes from Data URL (e.g. "data:image/png;base64,...")
        let raw_bytes = if let Some(idx) = img.data_url.find("base64,") {
            let b64 = &img.data_url[idx + 7..];
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|_| PdfiumError::ImageError)?
        } else {
            continue;
        };

        let dynamic_img = image::ImageReader::new(Cursor::new(raw_bytes))
            .with_guessed_format()
            .map_err(|_| PdfiumError::ImageError)?
            .decode()
            .map_err(|_| PdfiumError::ImageError)?;

        let pages = doc.pages();
        if let Ok(mut page) = pages.get(img.sheet as i32) {
            let page_h = page.height().value as f64;
            // Convert top-left coordinates to PDF bottom-left coordinates
            let pdf_x = img.x;
            let pdf_y = (page_h - (img.y + img.height)).max(0.0);

            let mut image_obj = PdfPageImageObject::new(
                &doc,
                &dynamic_img,
            )?;
            image_obj.scale(img.width as f32, img.height as f32)?;
            image_obj.translate(PdfPoints::new(pdf_x as f32), PdfPoints::new(pdf_y as f32))?;

            page.objects_mut().add_image_object(image_obj)?;
        }
    }

    doc.save_to_bytes()
}
