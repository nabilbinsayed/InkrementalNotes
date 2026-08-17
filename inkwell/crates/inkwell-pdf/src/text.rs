use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextSpan {
    pub text: String,
    pub rect: [f64; 4], // [x0, y0, x1, y1]
    pub page_index: usize,
}

pub fn extract_text(document: &PdfDocument<'_>, page_index: u32) -> Option<String> {
    let page = document.pages().get(page_index as i32).ok()?;
    let text = page.text().ok()?;
    Some(text.all())
}

pub fn extract_text_spans(document: &PdfDocument<'_>, page_index: u32) -> Vec<TextSpan> {
    let mut out = Vec::new();
    let Ok(page) = document.pages().get(page_index as i32) else { return out; };
    let Ok(text) = page.text() else { return out; };
    let page_h = page.height().value as f64;

    for segment in text.segments().iter() {
        let txt = segment.text();
        if txt.trim().is_empty() { continue; }
        let b = segment.bounds();
        let x0 = b.left().value as f64;
        let x1 = b.right().value as f64;
        let y_bottom = b.bottom().value as f64;
        let y_top = b.top().value as f64;
        // Convert PDF coordinate system (origin bottom-left) to Canvas coordinates (origin top-left)
        let y0 = page_h - y_top;
        let y1 = page_h - y_bottom;
        out.push(TextSpan {
            text: txt,
            rect: [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)],
            page_index: page_index as usize,
        });
    }
    out
}
