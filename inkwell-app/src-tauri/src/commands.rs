use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use std::path::{Path, PathBuf};
use inkwell_core::{Document, StrokeBuilder, ToolKind, Brush, PdfFile, wal::{atomic_write, Wal, WalEntry}};

/// Derive a temp-dir WAL path for `doc_path` that stays out of the synced
/// folder. Key = hex-encoded FNV-1a of the canonical path bytes.
fn wal_path_for(doc_path: &Path) -> PathBuf {
    let s = doc_path.to_string_lossy();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    std::env::temp_dir().join(format!("inkwell-wal-{:016x}.bin", h))
}

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

/// Extract page count and dimensions from PDF bytes using the cached PDFium instance.
/// Falls back to the shallow `PdfFile` reader if PDFium is unavailable.
fn get_page_infos(
    bytes: &[u8],
    state: &AppState,
    pdf_file_fallback: Option<&PdfFile>,
) -> Vec<PageInfo> {
    let pdfium_guard = state.pdfium.lock().unwrap();
    if let Some(pdfium) = pdfium_guard.as_ref() {
        match pdfium.load_pdf_from_byte_slice(bytes, None) {
            Ok(doc) => {
                let n = doc.pages().len() as usize;
                return (0..n)
                    .map(|i| {
                        let (w, h) = doc.pages()
                            .get(i as i32)
                            .ok()
                            .map(|p| (p.width().value as f64, p.height().value as f64))
                            .unwrap_or((595.0, 842.0));
                        PageInfo { page_index: i, width_pt: w, height_pt: h }
                    })
                    .collect();
            }
            Err(e) => {
                eprintln!("[inkwell] PDFium failed to load PDF for page info: {e:?}");
            }
        }
    } else {
        eprintln!("[inkwell] PDFium not available — falling back to shallow reader for page info.");
    }

    // Fallback: use the shallow PdfFile reader (only works for classic-xref PDFs)
    let n = pdf_file_fallback
        .map(|f| f.page_count())
        .unwrap_or(1);
    (0..n)
        .map(|i| PageInfo { page_index: i, width_pt: 595.0, height_pt: 842.0 })
        .collect()
}

/// Normalise PDF bytes using the cached PDFium instance.
/// Returns the original bytes unchanged if PDFium is unavailable or normalisation fails.
fn normalise_if_needed(bytes: Vec<u8>, state: &AppState) -> Result<(Vec<u8>, Option<PdfFile>), String> {
    match PdfFile::open(bytes.clone()) {
        Ok(f) => Ok((bytes, Some(f))),
        Err(e) => {
            eprintln!("[inkwell] Shallow PDF parser error ({e:?}), attempting PDFium normalisation...");
            let pdfium_guard = state.pdfium.lock().unwrap();
            match pdfium_guard.as_ref() {
                Some(pdfium) => {
                    match inkwell_pdf::normalise(pdfium, &bytes) {
                        Ok(norm_bytes) => {
                            eprintln!("[inkwell] PDFium normalisation succeeded ({} bytes -> {} bytes).", bytes.len(), norm_bytes.len());
                            // The normalised bytes should parse with the shallow reader now.
                            let f = PdfFile::open(norm_bytes.clone()).ok();
                            Ok((norm_bytes, f))
                        }
                        Err(norm_err) => {
                            // Normalisation failed: surface a real error rather than silently
                            // loading malformed bytes and showing a blank document.
                            Err(format!(
                                "Failed to parse PDF ({e}) and PDFium normalisation also failed: {norm_err:?}"
                            ))
                        }
                    }
                }
                None => {
                    // PDFium not available — this PDF format requires it.
                    Err(format!(
                        "Failed to parse PDF ({e}). PDFium is not available (pdfium.dll not found). \
                         This PDF format requires PDFium to open."
                    ))
                }
            }
        }
    }
}

#[tauri::command]
pub fn open_pdf(path_str: String, state: State<'_, AppState>) -> Result<Vec<PageInfo>, String> {
    let path = PathBuf::from(&path_str);
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read PDF file: {e}"))?;

    let (valid_bytes, pdf_file) = normalise_if_needed(bytes, &state)?;

    let page_infos = get_page_infos(&valid_bytes, &state, pdf_file.as_ref());
    let n_pages = page_infos.len();

    let doc = Document::for_pdf(n_pages);
    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path.clone());
    *state.pdf_bytes.lock().unwrap() = Some(valid_bytes);

    // Open WAL in temp dir (not the synced folder).
    let wp = wal_path_for(&path);
    match Wal::open(&wp) {
        Ok(wal) => { *state.wal.lock().unwrap() = Some(wal); }
        Err(e) => { eprintln!("[inkwell] WAL init failed ({wp:?}): {e}"); }
    }

    eprintln!("[inkwell] Opened PDF: {:?} — {} pages", path, n_pages);
    Ok(page_infos)
}

#[tauri::command]
pub fn open_pdf_bytes(name: String, bytes: Vec<u8>, state: State<'_, AppState>) -> Result<Vec<PageInfo>, String> {
    let path = std::env::temp_dir().join(&name);
    let _ = std::fs::write(&path, &bytes);

    let (valid_bytes, pdf_file) = normalise_if_needed(bytes, &state)?;

    let page_infos = get_page_infos(&valid_bytes, &state, pdf_file.as_ref());
    let n_pages = page_infos.len();

    let doc = Document::for_pdf(n_pages);
    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path.clone());
    *state.pdf_bytes.lock().unwrap() = Some(valid_bytes);

    let wp = wal_path_for(&path);
    match Wal::open(&wp) {
        Ok(wal) => { *state.wal.lock().unwrap() = Some(wal); }
        Err(e) => { eprintln!("[inkwell] WAL init failed ({wp:?}): {e}"); }
    }

    eprintln!("[inkwell] Opened PDF bytes: {:?} — {} pages", name, n_pages);
    Ok(page_infos)
}

#[tauri::command]
pub fn render_tile(
    page: u32,
    rect: [f64; 4],
    px: u32,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    if px == 0 {
        return Err("Tile size must be greater than zero".into());
    }
    if !(rect[0].is_finite() && rect[1].is_finite() && rect[2].is_finite() && rect[3].is_finite())
        || rect[2] <= rect[0]
        || rect[3] <= rect[1]
    {
        return Err(format!("Invalid tile rectangle: {rect:?}"));
    }

    // Grab PDF bytes without holding the lock during rendering.
    let bytes = state.pdf_bytes.lock().unwrap()
        .as_ref()
        .cloned()
        .ok_or("No PDF loaded")?;

    // Use the cached PDFium instance — no per-tile DLL loading.
    // We must hold the MutexGuard alive for the entire render because PdfDocument
    // borrows from the Pdfium instance behind the guard.
    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or_else(|| {
        "PDFium is not available (pdfium.dll was not found at startup). \
         PDF tiles cannot be rendered.".to_string()
    })?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let rasterizer = inkwell_pdf::PdfiumRasterizer::new(doc);
    let tile = inkwell_core::tiles::PageRasterizer::rasterize(&rasterizer, page, rect, px)
        .ok_or_else(|| format!("PDFium did not render page {page} for rect {rect:?} at {px}px"))?;

    // Rasterization done — release the PDFium lock before validating output.
    drop(rasterizer);
    drop(pdfium_guard);

    let expected_len = px as usize * px as usize * 3;
    if tile.data.len() != expected_len {
        return Err(format!(
            "PDFium returned an invalid tile buffer for page {page}: expected {expected_len} RGB bytes, got {}",
            tile.data.len()
        ));
    }

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
    doc.push_stroke(sheet, stroke.clone());

    // Append to WAL (fsynced inside wal.append).
    if let Some(wal) = state.wal.lock().unwrap().as_mut() {
        let _ = wal.append(&WalEntry::Added(stroke));
    }

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

    let (norm_bytes, mut pdf_file) = match PdfFile::open(input_bytes.clone()) {
        Ok(f) => (input_bytes.clone(), f),
        Err(e) => {
            eprintln!("[inkwell] Base PDF requires normalisation for writing ({e:?})...");
            let pdfium_guard = state.pdfium.lock().unwrap();
            let pdfium = pdfium_guard.as_ref().ok_or_else(|| {
                format!("Failed to open base PDF ({e}) and PDFium is unavailable for normalisation.")
            })?;
            let nb = inkwell_pdf::normalise(pdfium, input_bytes)
                .map_err(|norm_err| format!("PDFium normalisation failed during save: {norm_err:?}"))?;
            let f = PdfFile::open(nb.clone())
                .map_err(|open_err| format!("Failed to parse normalised PDF for writing: {open_err}"))?;
            (nb, f)
        }
    };

    pdf_file.write_document(doc, inkwell_core::pdf::DEFAULT_GROUP)
        .map_err(|e| format!("Failed to write document ink layers: {e}"))?;

    let final_bytes = pdf_file.finish();
    atomic_write(&target_path, &final_bytes)
        .map_err(|e| format!("Failed atomic save to {:?}: {e}", target_path))?;

    // Update in-memory state with normalised base bytes
    drop(bytes_guard);
    drop(doc_guard);
    *state.pdf_bytes.lock().unwrap() = Some(norm_bytes);

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

#[tauri::command]
pub fn insert_blank_page(
    index: usize,
    width_pt: f64,
    height_pt: f64,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;

    doc.insert_sheet(index);

    Ok(PageInfo {
        page_index: index,
        width_pt,
        height_pt,
    })
}
