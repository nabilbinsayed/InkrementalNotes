use pdfium_render::prelude::*;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TextAnnotation {
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub font_size: f64,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
}

fn parse_hex_color(hex: &str) -> (u8, u8, u8) {
    let clean = hex.trim().trim_start_matches('#');
    if clean.len() == 6 {
        let r = u8::from_str_radix(&clean[0..2], 16).unwrap_or(20);
        let g = u8::from_str_radix(&clean[2..4], 16).unwrap_or(23);
        let b = u8::from_str_radix(&clean[4..6], 16).unwrap_or(36);
        (r, g, b)
    } else {
        (20, 23, 36)
    }
}

pub fn embed_texts_in_pdf(
    pdfium: &Pdfium,
    pdf_bytes: &[u8],
    texts: &[TextAnnotation],
) -> Result<Vec<u8>, PdfiumError> {
    if texts.is_empty() {
        return Ok(pdf_bytes.to_vec());
    }

    let mut doc = pdfium.load_pdf_from_byte_slice(pdf_bytes, None)?;

    let font_regular = doc.fonts_mut().helvetica();
    let font_bold = doc.fonts_mut().helvetica_bold();
    let font_italic = doc.fonts_mut().helvetica_oblique();
    let font_bold_italic = doc.fonts_mut().helvetica_bold_oblique();

    for t in texts {
        let trimmed = t.text.trim();
        if trimmed.is_empty() {
            continue;
        }

        let font = if t.bold && t.italic {
            &font_bold_italic
        } else if t.bold {
            &font_bold
        } else if t.italic {
            &font_italic
        } else {
            &font_regular
        };

        let pages = doc.pages();
        if let Ok(mut page) = pages.get(t.sheet as i32) {
            let page_h = page.height().value as f64;
            let (r, g, b) = parse_hex_color(&t.color);
            let font_size = if t.font_size > 0.0 { t.font_size } else { 16.0 };
            let line_height = font_size * 1.35;

            let lines: Vec<&str> = t.text.split('\n').collect();
            for (line_idx, line) in lines.iter().enumerate() {
                if line.is_empty() {
                    continue;
                }
                let offset_y = t.y + (line_idx as f64) * line_height;
                let baseline_y = (page_h - offset_y - font_size).max(0.0);

                let mut text_obj = PdfPageTextObject::new(
                    &doc,
                    line,
                    *font,
                    PdfPoints::new(font_size as f32),
                )?;
                text_obj.set_fill_color(PdfColor::new(r, g, b, 255))?;
                text_obj.translate(PdfPoints::new(t.x as f32), PdfPoints::new(baseline_y as f32))?;

                page.objects_mut().add_text_object(text_obj)?;
            }
        }
    }

    doc.save_to_bytes()
}
