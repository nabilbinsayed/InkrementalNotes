use crate::state::{AppState, CachedPageBitmap, WalOp};
use serde::{Deserialize, Serialize};
use tauri::State;
use std::path::{Path, PathBuf};
use pdfium_render::prelude::*;
use inkwell_core::{Document, StrokeBuilder, ToolKind, Brush, PdfFile, wal::{atomic_write, Wal, WalEntry}};

fn init_wal_worker(wal: Wal) -> std::sync::mpsc::Sender<WalOp> {
    let (tx, rx) = std::sync::mpsc::channel::<WalOp>();
    std::thread::spawn(move || {
        let mut wal = wal;
        while let Ok(op) = rx.recv() {
            match op {
                WalOp::Append(entry) => {
                    if let Err(e) = wal.append(&entry) {
                        eprintln!("[inkwell] Background WAL append error: {e}");
                    }
                }
                WalOp::Truncate => {
                    if let Err(e) = wal.truncate() {
                        eprintln!("[inkwell] Background WAL truncate error: {e}");
                    }
                }
                WalOp::Close => break,
            }
        }
    });
    tx
}

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

use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn open_pdf_dialog(window: tauri::Window, state: State<'_, AppState>) -> Result<(String, Vec<PageInfo>), String> {
    let file_option = tauri::async_runtime::spawn_blocking(move || {
        window.dialog()
            .file()
            .add_filter("PDF Document", &["pdf"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(path) = file_option {
        let path_buf = path.into_path().map_err(|e| e.to_string())?;
        let path_str = path_buf.to_string_lossy().to_string();
        let infos = open_pdf(path_str.clone(), state)?;
        Ok((path_str, infos))
    } else {
        Err("CANCELLED".to_string())
    }
}

#[tauri::command]
pub fn open_pdf(path_str: String, state: State<'_, AppState>) -> Result<Vec<PageInfo>, String> {
    let path = PathBuf::from(&path_str);
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read PDF file: {e}"))?;

    let (valid_bytes, pdf_file) = normalise_if_needed(bytes, &state)?;

    let page_infos = get_page_infos(&valid_bytes, &state, pdf_file.as_ref());
    let n_pages = page_infos.len();

    let mut doc = Document::for_pdf(n_pages);

    // Replay WAL entries if journal exists from a previous crash
    let wp = wal_path_for(&path);
    if let Ok(entries) = Wal::replay(&wp) {
        if !entries.is_empty() {
            eprintln!("[inkwell] Replaying {} WAL entries for {:?}", entries.len(), path);
            for entry in entries {
                match entry {
                    WalEntry::Added(s) => doc.push_stroke(0, s),
                    WalEntry::Removed(id) => { doc.remove_stroke(id); }
                }
            }
        }
    }

    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path.clone());
    *state.pdf_bytes.lock().unwrap() = Some(valid_bytes);

    // Open WAL in temp dir (not the synced folder).
    if let Some(old_tx) = state.wal.lock().unwrap().take() {
        let _ = old_tx.send(WalOp::Close);
    }
    match Wal::open(&wp) {
        Ok(wal) => {
            let tx = init_wal_worker(wal);
            *state.wal.lock().unwrap() = Some(tx);
        }
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

    let mut doc = Document::for_pdf(n_pages);

    let wp = wal_path_for(&path);
    if let Ok(entries) = Wal::replay(&wp) {
        if !entries.is_empty() {
            eprintln!("[inkwell] Replaying {} WAL entries for {:?}", entries.len(), path);
            for entry in entries {
                match entry {
                    WalEntry::Added(s) => doc.push_stroke(0, s),
                    WalEntry::Removed(id) => { doc.remove_stroke(id); }
                }
            }
        }
    }

    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path.clone());
    *state.pdf_bytes.lock().unwrap() = Some(valid_bytes);

    if let Some(old_tx) = state.wal.lock().unwrap().take() {
        let _ = old_tx.send(WalOp::Close);
    }
    match Wal::open(&wp) {
        Ok(wal) => {
            let tx = init_wal_worker(wal);
            *state.wal.lock().unwrap() = Some(tx);
        }
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

    let rw = (rect[2] - rect[0]).max(1.0);
    let rh = (rect[3] - rect[1]).max(1.0);
    let scale = (px as f64) / rw.max(rh);

    let pdf_bytes_guard = state.pdf_bytes.lock().unwrap();
    let bytes = pdf_bytes_guard
        .as_ref()
        .ok_or("No PDF loaded")?;

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or_else(|| {
        "PDFium is not available (pdfium.dll was not found at startup). \
         PDF tiles cannot be rendered.".to_string()
    })?;

    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let page_obj = doc.pages().get(page as i32).map_err(|e| format!("PDFium page error: {e:?}"))?;
    let page_w = page_obj.width().value as f64;
    let page_h = page_obj.height().value as f64;

    let target_w = (page_w * scale).round().max(1.0) as i32;
    let target_h = (page_h * scale).round().max(1.0) as i32;

    let mut cache_guard = state.page_bitmap_cache.lock().unwrap();

    let (bgra_bytes, bitmap_w, bitmap_h) = match cache_guard.as_ref() {
        Some(c) if c.page == page && c.target_w == target_w && c.target_h == target_h => {
            (c.bgra_bytes.clone(), c.bitmap_w, c.bitmap_h)
        }
        _ => {
            let config = PdfRenderConfig::new()
                .set_target_width(target_w)
                .set_maximum_height(target_h)
                .set_clear_color(PdfColor::WHITE);

            let bitmap = page_obj.render_with_config(&config).map_err(|e| {
                format!("PDFium failed to render page {page}: {e:?}")
            })?;

            let bgra = bitmap.as_raw_bytes().to_vec();
            let bw = bitmap.width() as u32;
            let bh = bitmap.height() as u32;

            *cache_guard = Some(CachedPageBitmap {
                page,
                target_w,
                target_h,
                bgra_bytes: bgra.clone(),
                bitmap_w: bw,
                bitmap_h: bh,
            });

            (bgra, bw, bh)
        }
    };
    drop(cache_guard);


    // Crop the tile rect from the page bitmap
    let out_w = (rw * scale).round().max(1.0) as u32;
    let out_h = (rh * scale).round().max(1.0) as u32;

    let x0 = (rect[0] * scale).round().max(0.0) as u32;
    let y0 = (rect[1] * scale).round().max(0.0) as u32;

    let mut rgba_data = vec![255u8; (out_w * out_h * 4) as usize];
    if x0 < bitmap_w && y0 < bitmap_h {
        let crop_w = out_w.min(bitmap_w.saturating_sub(x0));
        let crop_h = out_h.min(bitmap_h.saturating_sub(y0));

        for y in 0..crop_h {
            for x in 0..crop_w {
                let src_idx = ((y0 + y) * bitmap_w + (x0 + x)) as usize * 4;
                let dst_idx = (y * out_w + x) as usize * 4;

                if src_idx + 3 < bgra_bytes.len() {
                    let b = bgra_bytes[src_idx];
                    let g = bgra_bytes[src_idx + 1];
                    let r = bgra_bytes[src_idx + 2];
                    let a = bgra_bytes[src_idx + 3] as u32;

                    let blended_r = ((r as u32 * a + 255 * (255 - a)) / 255) as u8;
                    let blended_g = ((g as u32 * a + 255 * (255 - a)) / 255) as u8;
                    let blended_b = ((b as u32 * a + 255 * (255 - a)) / 255) as u8;

                    rgba_data[dst_idx] = blended_r;
                    rgba_data[dst_idx + 1] = blended_g;
                    rgba_data[dst_idx + 2] = blended_b;
                    rgba_data[dst_idx + 3] = 255;
                }
            }
        }
    }

    let expected_len = (out_w as usize) * (out_h as usize) * 4;
    if rgba_data.len() != expected_len {
        return Err(format!(
            "PDFium returned an invalid tile buffer for page {page}: expected {expected_len} RGBA bytes ({out_w}x{out_h}), got {}",
            rgba_data.len()
        ));
    }

    Ok(rgba_data)
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

    // Offload WAL append to background worker thread channel.
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::Added(stroke)));
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

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Truncate);
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
