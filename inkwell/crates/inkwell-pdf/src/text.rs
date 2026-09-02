use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextSpan {
    pub text: String,
    pub rect: [f64; 4], // [x0, y0, x1, y1]
    pub page_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharSpan {
    pub c: String,
    pub rect: [f64; 4], // [x0, y0, x1, y1] in top-left canvas coords
    pub char_index: usize,
    pub line_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextLine {
    pub line_index: usize,
    pub page_index: usize,
    pub rect: [f64; 4], // [min_x, min_y, max_x, max_y] of the line
    pub text: String,
    pub start_char_index: usize,
    pub end_char_index: usize,
    pub chars: Vec<CharSpan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageTextData {
    pub page_index: usize,
    pub text: String,
    pub lines: Vec<TextLine>,
    pub chars: Vec<CharSpan>,
    pub spans: Vec<TextSpan>,
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

pub fn extract_page_text_data(document: &PdfDocument<'_>, page_index: u32) -> PageTextData {
    let mut lines: Vec<TextLine> = Vec::new();
    let mut all_chars: Vec<CharSpan> = Vec::new();
    let mut word_spans: Vec<TextSpan> = Vec::new();

    let Ok(page) = document.pages().get(page_index as i32) else {
        return PageTextData {
            page_index: page_index as usize,
            text: String::new(),
            lines,
            chars: all_chars,
            spans: word_spans,
        };
    };
    let Ok(text) = page.text() else {
        return PageTextData {
            page_index: page_index as usize,
            text: String::new(),
            lines,
            chars: all_chars,
            spans: word_spans,
        };
    };
    let page_h = page.height().value as f64;
    let full_text = text.all();

    for segment in text.segments().iter() {
        let txt = segment.text();
        if txt.trim().is_empty() { continue; }
        let b = segment.bounds();
        let x0 = b.left().value as f64;
        let x1 = b.right().value as f64;
        let y_bottom = b.bottom().value as f64;
        let y_top = b.top().value as f64;
        let y0 = page_h - y_top;
        let y1 = page_h - y_bottom;
        word_spans.push(TextSpan {
            text: txt,
            rect: [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)],
            page_index: page_index as usize,
        });
    }

    let chars_coll = text.chars();
    let total_chars = chars_coll.len();
    if total_chars == 0 {
        return PageTextData {
            page_index: page_index as usize,
            text: full_text,
            lines,
            chars: all_chars,
            spans: word_spans,
        };
    }

    // Pass 1: Extract raw character coordinates
    struct RawChar {
        c: String,
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
        char_index: usize,
        has_bounds: bool,
    }

    let mut raw_chars: Vec<RawChar> = Vec::with_capacity(total_chars);
    for (i, char_obj) in chars_coll.iter().enumerate() {
        let ch_str = char_obj.unicode_string().unwrap_or_default();
        let b = char_obj.tight_bounds().or_else(|_| char_obj.loose_bounds());
        if let Ok(b) = b {
            let left = b.left().value as f64;
            let right = b.right().value as f64;
            let top = b.top().value as f64;
            let bottom = b.bottom().value as f64;
            let x0 = left.min(right);
            let x1 = left.max(right);
            let y0 = page_h - top.max(bottom);
            let y1 = page_h - top.min(bottom);
            let has_bounds = (x1 - x0).abs() > 0.001 && (y1 - y0).abs() > 0.001;
            raw_chars.push(RawChar {
                c: ch_str,
                x0,
                y0,
                x1,
                y1,
                char_index: i,
                has_bounds,
            });
        } else {
            raw_chars.push(RawChar {
                c: ch_str,
                x0: 0.0,
                y0: 0.0,
                x1: 0.0,
                y1: 0.0,
                char_index: i,
                has_bounds: false,
            });
        }
    }

    // Pass 2: Partition characters into distinct lines in reading order
    let mut current_line: Vec<usize> = Vec::new();
    let mut line_groups: Vec<Vec<usize>> = Vec::new();

    let mut line_min_y = f64::INFINITY;
    let mut line_max_y = f64::NEG_INFINITY;
    let mut line_min_x = f64::INFINITY;
    let mut _line_max_x = f64::NEG_INFINITY;

    for (idx, rc) in raw_chars.iter().enumerate() {
        let is_newline = rc.c == "\n" || rc.c == "\r";

        let starts_new_line = if current_line.is_empty() || is_newline {
            false
        } else if rc.has_bounds && line_min_y.is_finite() {
            let line_h = (line_max_y - line_min_y).max(6.0);
            let line_mid_y = (line_min_y + line_max_y) / 2.0;
            let cur_mid_y = (rc.y0 + rc.y1) / 2.0;
            let vert_diff = (cur_mid_y - line_mid_y).abs();

            vert_diff > line_h * 0.6 || (rc.x0 < line_min_x - 10.0 && vert_diff > 3.0)
        } else {
            false
        };

        if starts_new_line && !current_line.is_empty() {
            line_groups.push(std::mem::take(&mut current_line));
            line_min_y = f64::INFINITY;
            line_max_y = f64::NEG_INFINITY;
            line_min_x = f64::INFINITY;
            _line_max_x = f64::NEG_INFINITY;
        }

        if is_newline {
            if !current_line.is_empty() {
                line_groups.push(std::mem::take(&mut current_line));
                line_min_y = f64::INFINITY;
                line_max_y = f64::NEG_INFINITY;
                line_min_x = f64::INFINITY;
                _line_max_x = f64::NEG_INFINITY;
            }
        } else {
            if rc.has_bounds {
                line_min_y = line_min_y.min(rc.y0);
                line_max_y = line_max_y.max(rc.y1);
                line_min_x = line_min_x.min(rc.x0);
                _line_max_x = _line_max_x.max(rc.x1);
            }
            current_line.push(idx);
        }
    }

    if !current_line.is_empty() {
        line_groups.push(current_line);
    }

    // Pass 3: Construct standardized TextLine and CharSpan objects with aligned vertical bounds
    for (line_idx, char_indices) in line_groups.into_iter().enumerate() {
        if char_indices.is_empty() { continue; }

        let mut l_min_x = f64::INFINITY;
        let mut l_max_x = f64::NEG_INFINITY;
        let mut l_min_y = f64::INFINITY;
        let mut l_max_y = f64::NEG_INFINITY;

        for &c_idx in &char_indices {
            let rc = &raw_chars[c_idx];
            if rc.has_bounds {
                l_min_x = l_min_x.min(rc.x0);
                l_max_x = l_max_x.max(rc.x1);
                l_min_y = l_min_y.min(rc.y0);
                l_max_y = l_max_y.max(rc.y1);
            }
        }

        if !l_min_x.is_finite() {
            l_min_x = 0.0;
            l_max_x = 0.0;
            l_min_y = 0.0;
            l_max_y = 12.0;
        }

        let unified_y0 = l_min_y - 1.0;
        let unified_y1 = l_max_y + 1.0;

        let mut line_char_spans: Vec<CharSpan> = Vec::with_capacity(char_indices.len());
        let mut line_text = String::new();

        for (pos_in_line, &c_idx) in char_indices.iter().enumerate() {
            let rc = &raw_chars[c_idx];
            line_text.push_str(&rc.c);

            let (cx0, cx1) = if rc.has_bounds {
                (rc.x0, rc.x1)
            } else if pos_in_line > 0 {
                let prev_x1 = line_char_spans.last().map(|c| c.rect[2]).unwrap_or(l_min_x);
                (prev_x1, prev_x1 + 4.0)
            } else {
                (l_min_x, l_min_x + 4.0)
            };

            let span = CharSpan {
                c: rc.c.clone(),
                rect: [cx0, unified_y0, cx1, unified_y1],
                char_index: rc.char_index,
                line_index: line_idx,
            };
            all_chars.push(span.clone());
            line_char_spans.push(span);
        }

        let start_char_idx = line_char_spans.first().map(|c| c.char_index).unwrap_or(0);
        let end_char_idx = line_char_spans.last().map(|c| c.char_index + 1).unwrap_or(0);

        lines.push(TextLine {
            line_index: line_idx,
            page_index: page_index as usize,
            rect: [l_min_x, unified_y0, l_max_x, unified_y1],
            text: line_text,
            start_char_index: start_char_idx,
            end_char_index: end_char_idx,
            chars: line_char_spans,
        });
    }

    all_chars.sort_by_key(|c| c.char_index);

    PageTextData {
        page_index: page_index as usize,
        text: full_text,
        lines,
        chars: all_chars,
        spans: word_spans,
    }
}
