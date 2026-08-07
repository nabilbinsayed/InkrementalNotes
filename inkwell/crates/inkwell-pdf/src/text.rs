use pdfium_render::prelude::*;

pub fn extract_text(document: &PdfDocument<'_>, page_index: u32) -> Option<String> {
    let page = document.pages().get(page_index as i32).ok()?;
    let text = page.text().ok()?;
    Some(text.all())
}
