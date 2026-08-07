use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use std::path::PathBuf;
use inkwell_core::{Document, StrokeBuilder, ToolKind, Brush};

#[derive(Debug, Serialize, Deserialize)]
pub struct PageInfo {
    pub page_index: usize,
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(Debug, Deserialize)]
pub struct RawSampleInput {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub t_ms: f64,
}

#[tauri::command]
pub fn open_pdf(path_str: String, state: State<'_, AppState>) -> Result<Vec<PageInfo>, String> {
    let path = PathBuf::from(&path_str);
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read PDF file: {e}"))?;

    // Attempt opening or normalising
    let open_res = inkwell_core::pdf::PdfFile::open(bytes.clone());
    let (valid_bytes, pdf_file) = match open_res {
        Ok(f) => (bytes, f),
        Err(inkwell_core::pdfobj::Error::XrefStream) => {
            // Needs normalisation via PDFium if available
            return Err("PDF uses cross-reference streams. PDFium normalisation is required.".into());
        }
        Err(e) => return Err(format!("Failed to parse PDF: {e}")),
    };

    let n_pages = pdf_file.page_count();
    let doc = Document::for_pdf(n_pages);

    let page_infos: Vec<PageInfo> = (0..n_pages)
        .map(|i| {
            let (w, h) = pdf_file.page_size(i).unwrap_or((595.0, 842.0));
            PageInfo { page_index: i, width_pt: w, height_pt: h }
        })
        .collect();

    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path);
    *state.pdf_bytes.lock().unwrap() = Some(valid_bytes);

    Ok(page_infos)
}

#[tauri::command]
pub fn commit_stroke(
    sheet: usize,
    tool: String,
    rgb: [f64; 3],
    base_width: f64,
    samples: Vec<RawSampleInput>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;

    let tool_kind = match tool.as_str() {
        "highlighter" => ToolKind::Highlighter,
        _ => ToolKind::Pen,
    };

    let stroke_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();

    let brush = Brush {
        base_width,
        min_width_factor: 0.22,
        gamma: 1.0,
    };

    let mut b = StrokeBuilder::new(stroke_id, tool_kind, [rgb[0], rgb[1], rgb[2]], brush, true);
    for s in samples {
        b.push(s.x, s.y, s.pressure, s.t_ms);
    }

    let stroke = b.finish(0.3);
    doc.push_stroke(sheet, stroke);

    Ok(stroke_id.to_string())
}

#[tauri::command]
pub fn delete_stroke(stroke_id_str: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;

    let id = stroke_id_str.parse::<u128>().map_err(|e| e.to_string())?;
    Ok(doc.remove_stroke(id))
}

#[tauri::command]
pub fn get_document_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_ref().ok_or("No document open")?;

    Ok(serde_json::json!({
        "sheets": doc.sheets.len(),
        "strokes": doc.stroke_count(),
        "samples": doc.sample_count(),
    }))
}
