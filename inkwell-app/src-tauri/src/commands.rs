use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use std::path::PathBuf;
use inkwell_core::{Document, StrokeBuilder, ToolKind, Brush, PdfFile, wal::atomic_write};

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

    let open_res = PdfFile::open(bytes.clone());
    let (valid_bytes, pdf_file) = match open_res {
        Ok(f) => (bytes, f),
        Err(inkwell_core::pdfobj::Error::XrefStream) => {
            // Normalise xref stream PDFs using PDFium
            match inkwell_pdf::init_pdfium() {
                Ok(pdfium) => {
                    let norm_bytes = inkwell_pdf::normalise(&pdfium, &bytes)
                        .map_err(|e| format!("PDFium normalisation failed: {e:?}"))?;
                    let f = PdfFile::open(norm_bytes.clone())
                        .map_err(|e| format!("Failed to open normalised PDF: {e}"))?;
                    (norm_bytes, f)
                }
                Err(e) => return Err(format!("PDF uses object streams and PDFium is unavailable: {e:?}")),
            }
        }
        Err(e) => return Err(format!("Failed to parse PDF: {e}")),
    };

    let n_pages = pdf_file.page_count();
    let doc = Document::for_pdf(n_pages);

    let page_infos: Vec<PageInfo> = {
        let pdfium_opt = inkwell_pdf::init_pdfium().ok();
        let pdfium_doc_opt = pdfium_opt.as_ref().and_then(|p| p.load_pdf_from_byte_slice(&valid_bytes, None).ok());
        (0..n_pages)
            .map(|i| {
                let (w, h) = pdfium_doc_opt.as_ref()
                    .and_then(|d| d.pages().get(i as i32).ok())
                    .map(|p| (p.width().value as f64, p.height().value as f64))
                    .unwrap_or((595.0, 842.0));
                PageInfo { page_index: i, width_pt: w, height_pt: h }
            })
            .collect()
    };

    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path);
    *state.pdf_bytes.lock().unwrap() = Some(valid_bytes);

    Ok(page_infos)
}

#[tauri::command]
pub fn render_tile(
    page: u32,
    rect: [f64; 4],
    px: u32,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let pdf_bytes_guard = state.pdf_bytes.lock().unwrap();
    let bytes = pdf_bytes_guard.as_ref().ok_or("No PDF loaded")?;

    let pdfium = inkwell_pdf::init_pdfium().map_err(|e| format!("PDFium init error: {e:?}"))?;
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let rasterizer = inkwell_pdf::PdfiumRasterizer::new(doc);
    let tile = inkwell_core::tiles::PageRasterizer::rasterize(&rasterizer, page, rect, px)
        .ok_or("Failed to rasterize tile")?;

    Ok(tile.data)
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
        min_ratio: 0.22,
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
pub fn save_pdf(out_path_str: Option<String>, state: State<'_, AppState>) -> Result<String, String> {
    let doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_ref().ok_or("No document open")?;

    let bytes_guard = state.pdf_bytes.lock().unwrap();
    let input_bytes = bytes_guard.as_ref().ok_or("No PDF loaded")?;

    let target_path = if let Some(p) = out_path_str {
        PathBuf::from(p)
    } else {
        state.pdf_path.lock().unwrap().clone().ok_or("No target file path")?
    };

    let mut pdf_file = PdfFile::open(input_bytes.clone())
        .map_err(|e| format!("Failed to open base PDF for writing: {e}"))?;

    pdf_file.write_document(doc, inkwell_core::pdf::DEFAULT_GROUP)
        .map_err(|e| format!("Failed to write document ink layers: {e}"))?;

    let final_bytes = pdf_file.finish();
    atomic_write(&target_path, &final_bytes)
        .map_err(|e| format!("Failed atomic save to {:?}: {e}", target_path))?;

    if let Some(wal) = state.wal.lock().unwrap().as_mut() {
        let _ = wal.truncate();
    }

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn erase_strokes_near(
    sheet: usize,
    px: f64,
    py: f64,
    radius: f64,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    let removed = doc.erase_strokes_near(sheet, px, py, radius);
    Ok(removed.into_iter().map(|id| id.to_string()).collect())
}

#[tauri::command]
pub fn erase_strokes_in_rect(
    sheet: usize,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    let removed = doc.erase_strokes_in_rect(sheet, x0, y0, x1, y1);
    Ok(removed.into_iter().map(|id| id.to_string()).collect())
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
