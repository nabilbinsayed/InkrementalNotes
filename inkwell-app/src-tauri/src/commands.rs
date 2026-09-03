use crate::state::{AppState, CachedPageBitmap, WalOp};
use serde::{Deserialize, Serialize};
use tauri::State;
use std::sync::Arc;
use std::path::{Path, PathBuf};
use pdfium_render::prelude::*;
use inkwell_core::{Document, Sample, Stroke, ToolKind, Brush, PdfFile, SidecarStatus, wal::{atomic_write, Wal, WalEntry}};

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

fn hash_bytes_fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn parse_stroke_id(s: &str) -> u128 {
    let s_clean = s.trim_start_matches("0x");
    if s_clean.len() == 32 {
        u128::from_str_radix(s_clean, 16).unwrap_or(0)
    } else {
        s.parse::<u128>().or_else(|_| u128::from_str_radix(s_clean, 16)).unwrap_or_else(|_| {
            hash_bytes_fnv1a(s.as_bytes()) as u128
        })
    }
}

/// Derive a safe WAL path for `doc_path` that stays out of the synced folder.
/// Key = hex-encoded FNV-1a of the canonical path bytes.
/// On Windows: uses %TEMP% directly.
/// On Unix/Linux: uses $XDG_STATE_HOME/inkwell/wal (or ~/.local/state/inkwell/wal) to persist across reboots.
fn wal_path_for(doc_path: &Path) -> PathBuf {
    let s = doc_path.to_string_lossy();
    let h = hash_bytes_fnv1a(s.as_bytes());
    let filename = format!("inkwell-wal-{:016x}.bin", h);

    #[cfg(windows)]
    {
        std::env::temp_dir().join(filename)
    }

    #[cfg(not(windows))]
    {
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
                home.join(".local").join("state")
            })
            .join("inkwell")
            .join("wal");
        let _ = std::fs::create_dir_all(&base);
        base.join(filename)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PageInfo {
    pub page_index: usize,
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendSample {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub p: f64,
    pub t: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendStroke {
    pub id: String,
    pub kind: String,
    pub rgb: [f64; 3],
    pub base_width: f64,
    pub points: Vec<FrontendSample>,
    pub sheet: usize,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendImage {
    pub id: String,
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendText {
    pub id: String,
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub font_size: f64,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub width: f64,
    pub height: f64,
}

/// Result of opening a PDF: page dimensions plus recovered/loaded strokes, images, texts and outline.
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenPdfResult {
    pub page_infos: Vec<PageInfo>,
    pub recovered_strokes: usize,
    pub recovered_images: usize,
    pub recovered_texts: usize,
    pub loaded_strokes: Vec<FrontendStroke>,
    pub loaded_images: Vec<FrontendImage>,
    pub loaded_texts: Vec<FrontendText>,
    pub outline: Vec<inkwell_pdf::TocItem>,
}

#[derive(Debug, Deserialize)]
pub struct RawSampleInput {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub t_ms: f64,
}

fn extract_frontend_strokes(doc: &Document) -> Vec<FrontendStroke> {
    let mut out = Vec::new();
    for (sheet_idx, sheet) in doc.sheets.iter().enumerate() {
        for stroke in sheet.strokes() {
            let kind_str = match stroke.kind {
                ToolKind::Highlighter => "highlighter",
                ToolKind::Pen => "pen",
            };
            let points = stroke.samples.iter().map(|s| FrontendSample {
                x: s.x,
                y: s.y,
                w: stroke.brush.width_for(s.p),
                p: s.p,
                t: s.t,
            }).collect();
            out.push(FrontendStroke {
                id: stroke.id_hex(),
                kind: kind_str.to_string(),
                rgb: stroke.rgb,
                base_width: stroke.brush.base_width,
                points,
                sheet: sheet_idx,
                deleted: false,
            });
        }
    }
    out
}

/// Extract page count, dimensions, and table of contents from PDF bytes using PDFium.
/// Falls back to the shallow `PdfFile` reader if PDFium is unavailable.
fn extract_pdf_meta(
    bytes: &[u8],
    state: &AppState,
) -> (Vec<PageInfo>, Vec<inkwell_pdf::TocItem>) {
    let pdfium_guard = state.pdfium.lock().unwrap();
    if let Some(pdfium) = pdfium_guard.as_ref() {
        match pdfium.load_pdf_from_byte_slice(bytes, None) {
            Ok(doc) => {
                let n = doc.pages().len() as usize;
                let page_infos = (0..n)
                    .map(|i| {
                        let (w, h) = doc.pages()
                            .get(i as i32)
                            .ok()
                            .map(|p| (p.width().value as f64, p.height().value as f64))
                            .unwrap_or((595.0, 842.0));
                        PageInfo { page_index: i, width_pt: w, height_pt: h }
                    })
                    .collect();
                let outline = inkwell_pdf::extract_outline(&doc);
                return (page_infos, outline);
            }
            Err(e) => {
                eprintln!("[inkwell] PDFium failed to load PDF for metadata: {e:?}");
            }
        }
    } else {
        eprintln!("[inkwell] PDFium not available — falling back to shallow reader for page info.");
    }

    // Fallback: use the shallow PdfFile reader (only works for classic-xref PDFs)
    let n = PdfFile::open(bytes.to_vec())
        .map(|f| f.page_count())
        .unwrap_or(1);
    let page_infos = (0..n)
        .map(|i| PageInfo { page_index: i, width_pt: 595.0, height_pt: 842.0 })
        .collect();
    (page_infos, Vec::new())
}

use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn open_pdf_dialog(window: tauri::Window, state: State<'_, AppState>) -> Result<(String, OpenPdfResult), String> {
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
        let result = open_pdf(path_str.clone(), state).await?;
        Ok((path_str, result))
    } else {
        Err("CANCELLED".to_string())
    }
}

fn replay_wal_journal(
    path: &Path,
    doc: &mut Document,
) -> (usize, usize, usize, Vec<FrontendImage>, Vec<FrontendText>) {
    let wp = wal_path_for(path);
    let mut recovered_strokes = 0usize;
    let mut recovered_images = 0usize;
    let mut recovered_texts = 0usize;
    let mut images_map: std::collections::HashMap<String, FrontendImage> = std::collections::HashMap::new();
    let mut texts_map: std::collections::HashMap<String, FrontendText> = std::collections::HashMap::new();

    if let Ok(entries) = Wal::replay(&wp) {
        if !entries.is_empty() {
            eprintln!("[inkwell] Replaying {} WAL entries for {:?}", entries.len(), path);
            for entry in entries {
                match entry {
                    WalEntry::Added { sheet, stroke } => {
                        doc.push_stroke(sheet, stroke);
                        recovered_strokes += 1;
                    }
                    WalEntry::Removed(id) => {
                        doc.remove_stroke(id);
                    }
                    WalEntry::PageInserted { index, .. } => {
                        doc.insert_sheet(index);
                    }
                    WalEntry::PageDeleted { index } => {
                        if index < doc.sheets.len() && doc.sheets.len() > 1 {
                            doc.sheets.remove(index);
                        }
                    }
                    WalEntry::PageReordered { from_index, to_index } => {
                        if from_index < doc.sheets.len() && to_index < doc.sheets.len() && from_index != to_index {
                            let sheet = doc.sheets.remove(from_index);
                            doc.sheets.insert(to_index, sheet);
                        }
                    }
                    WalEntry::PageRotated { .. } => {}
                    WalEntry::ImageAdded { sheet, id, x, y, width, height, data_url } => {
                        images_map.insert(id.clone(), FrontendImage { id, sheet, x, y, width, height, data_url });
                        recovered_images += 1;
                    }
                    WalEntry::ImageRemoved { id } => {
                        images_map.remove(&id);
                    }
                    WalEntry::TextUpsert { sheet, id, x, y, text, font_size, color, bold, italic, width, height } => {
                        texts_map.insert(id.clone(), FrontendText { id, sheet, x, y, text, font_size, color, bold, italic, width, height });
                        recovered_texts += 1;
                    }
                    WalEntry::TextRemoved { id } => {
                        texts_map.remove(&id);
                    }
                }
            }
        }
    }
    (
        recovered_strokes,
        recovered_images,
        recovered_texts,
        images_map.into_values().collect(),
        texts_map.into_values().collect(),
    )
}

#[tauri::command]
pub async fn open_pdf(path_str: String, state: State<'_, AppState>) -> Result<OpenPdfResult, String> {
    let path = PathBuf::from(&path_str);
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read PDF file: {e}"))?;

    let arc_bytes = Arc::new(bytes);
    let (page_infos, outline) = extract_pdf_meta(&arc_bytes, &state);
    let n_pages = page_infos.len();

    let mut doc = match inkwell_core::pdf::read_sidecar(&arc_bytes) {
        Ok(SidecarStatus::Ok(d)) | Ok(SidecarStatus::Stale(d)) => {
            eprintln!("[inkwell] Loaded sidecar with {} strokes from {:?}", d.stroke_count(), path);
            let mut d = d;
            while d.sheets.len() < n_pages {
                d.sheets.push(inkwell_core::doc::Sheet::bounded(d.sheets.len()));
            }
            d
        }
        _ => Document::for_pdf(n_pages),
    };

    // Replay WAL entries if journal exists from a previous crash
    let (recovered_strokes, recovered_images, recovered_texts, loaded_images, loaded_texts) =
        replay_wal_journal(&path, &mut doc);

    let loaded_strokes = extract_frontend_strokes(&doc);

    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path.clone());
    *state.pdf_bytes.lock().unwrap() = Some(arc_bytes.clone());
    *state.original_pdf_bytes.lock().unwrap() = Some(arc_bytes);
    state.page_bitmap_cache.lock().unwrap().clear();

    if let Ok(mut dim_guard) = state.page_dimensions.lock() {
        dim_guard.clear();
        for pi in &page_infos {
            dim_guard.insert(pi.page_index as u32, (pi.width_pt, pi.height_pt));
        }
    }

    // Open WAL in temp dir (not the synced folder).
    let wp = wal_path_for(&path);
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

    eprintln!("[inkwell] Opened PDF: {:?} — {} pages, {} loaded strokes, {} loaded images, {} loaded texts, {} outline nodes", path, n_pages, loaded_strokes.len(), loaded_images.len(), loaded_texts.len(), outline.len());
    Ok(OpenPdfResult {
        page_infos,
        recovered_strokes,
        recovered_images,
        recovered_texts,
        loaded_strokes,
        loaded_images,
        loaded_texts,
        outline,
    })
}

#[tauri::command]
pub async fn create_blank_document(
    title: Option<String>,
    width_pt: Option<f64>,
    height_pt: Option<f64>,
    state: State<'_, AppState>,
) -> Result<OpenPdfResult, String> {
    let doc_title = title.unwrap_or_else(|| "Untitled Whiteboard.pdf".to_string());
    let w = width_pt.unwrap_or(841.89);
    let h = height_pt.unwrap_or(595.28);
    if !w.is_finite() || !h.is_finite() || w < 72.0 || h < 72.0 || w > 14400.0 || h > 14400.0 {
        return Err(format!("Invalid whiteboard dimensions: {w} x {h} pt (must be between 72 and 14400)"));
    }

    let pdf_bytes = {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            use pdfium_render::prelude::*;
            let mut doc = pdfium.create_new_pdf().map_err(|e| e.to_string())?;
            doc.pages_mut().create_page_at_index(
                PdfPagePaperSize::Custom(PdfPoints::new(w as f32), PdfPoints::new(h as f32)),
                0,
            ).map_err(|e| e.to_string())?;
            doc.save_to_bytes().map_err(|e| e.to_string())?
        } else {
            format!(
"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] /Resources <<>> >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n215\n%%EOF\n", w, h
            ).into_bytes()
        }
    };

    open_pdf_bytes(doc_title, pdf_bytes, state).await
}

#[tauri::command]
pub async fn open_pdf_bytes(name: String, bytes: Vec<u8>, state: State<'_, AppState>) -> Result<OpenPdfResult, String> {
    // Derive a stable temp-file name from the content so different PDFs that
    // happen to share a file name get distinct WAL journals (and re-opening the
    // same dropped file still recovers its crash journal).
    let h = hash_bytes_fnv1a(&bytes[..bytes.len().min(8192)]);
    let clean_name = Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.chars().filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_').collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "document.pdf".to_string());
    let path = std::env::temp_dir().join(format!("inkwell-{:016x}-{}", h, clean_name));
    let _ = std::fs::write(&path, &bytes);

    let arc_bytes = Arc::new(bytes);
    let (page_infos, outline) = extract_pdf_meta(&arc_bytes, &state);
    let n_pages = page_infos.len();

    let mut doc = match inkwell_core::pdf::read_sidecar(&arc_bytes) {
        Ok(SidecarStatus::Ok(d)) | Ok(SidecarStatus::Stale(d)) => {
            eprintln!("[inkwell] Loaded sidecar with {} strokes from bytes ({})", d.stroke_count(), name);
            let mut d = d;
            while d.sheets.len() < n_pages {
                d.sheets.push(inkwell_core::doc::Sheet::bounded(d.sheets.len()));
            }
            d
        }
        _ => Document::for_pdf(n_pages),
    };

    let (recovered_strokes, recovered_images, recovered_texts, loaded_images, loaded_texts) =
        replay_wal_journal(&path, &mut doc);

    let loaded_strokes = extract_frontend_strokes(&doc);

    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path.clone());
    *state.pdf_bytes.lock().unwrap() = Some(arc_bytes.clone());
    *state.original_pdf_bytes.lock().unwrap() = Some(arc_bytes);
    state.page_bitmap_cache.lock().unwrap().clear();

    if let Ok(mut dim_guard) = state.page_dimensions.lock() {
        dim_guard.clear();
        for pi in &page_infos {
            dim_guard.insert(pi.page_index as u32, (pi.width_pt, pi.height_pt));
        }
    }

    let wp = wal_path_for(&path);
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

    eprintln!("[inkwell] Opened PDF bytes: {:?} — {} pages, {} loaded strokes, {} loaded images, {} loaded texts, {} outline nodes", name, n_pages, loaded_strokes.len(), loaded_images.len(), loaded_texts.len(), outline.len());
    Ok(OpenPdfResult {
        page_infos,
        recovered_strokes,
        recovered_images,
        recovered_texts,
        loaded_strokes,
        loaded_images,
        loaded_texts,
        outline,
    })
}

#[tauri::command]
pub async fn render_tile(
    page: u32,
    rect: [f64; 4],
    px: u32,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    // Cap tile resolution to bound the IPC payload size (RGBA = w*h*4 bytes).
    let px = px.clamp(16, 2048);
    if !(rect[0].is_finite() && rect[1].is_finite() && rect[2].is_finite() && rect[3].is_finite())
        || rect[2] <= rect[0]
        || rect[3] <= rect[1]
    {
        return Err(format!("Invalid tile rectangle: {rect:?}"));
    }

    let rw = (rect[2] - rect[0]).max(1.0);
    let rh = (rect[3] - rect[1]).max(1.0);
    let tile_pt = 256.0_f64;
    let scale = ((px as f64) / tile_pt).clamp(0.1, 4.0);

    // Get an atomic Arc clone under a short-lived lock (zero heap allocation)
    let arc_bytes = state
        .pdf_bytes
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?
        .clone()
        .ok_or("No PDF loaded")?;

    let (bgra_bytes, bitmap_w, bitmap_h) = {
        let (page_w, page_h) = {
            let dim_guard = state.page_dimensions.lock().map_err(|e| format!("Lock error: {e}"))?;
            dim_guard.get(&page).copied().unwrap_or((595.0, 842.0))
        };

        let target_w = ((page_w * scale).round().max(1.0) as i32).min(4096);
        let target_h = ((page_h * scale).round().max(1.0) as i32).min(4096);

        let cached = {
            let mut cache_guard = state.page_bitmap_cache.lock().map_err(|e| format!("Lock error: {e}"))?;
            cache_guard.get(page, target_w, target_h)
        };

        if let Some(cached_data) = cached {
            cached_data
        } else {
            let pdfium_guard = state.pdfium.lock().map_err(|e| format!("Lock error: {e}"))?;
            let pdfium = pdfium_guard.as_ref().ok_or_else(|| {
                "PDFium is not available (pdfium.dll was not found at startup). \
                 PDF tiles cannot be rendered.".to_string()
            })?;

            let mut doc = pdfium
                .load_pdf_from_byte_slice(&arc_bytes, None)
                .map_err(|e| format!("PDFium load error: {e:?}"))?;

            let mut page_obj = doc.pages_mut().get(page as i32).map_err(|e| format!("PDFium page error: {e:?}"))?;

            // Filter out InkWell-authored annotations in-memory so they are not baked into
            // the background bitmap tile (avoiding ghosting and preserving full interactive erasing/selection).
            // Third-party annotations (from Okular, Acrobat, Drawboard, etc.) are preserved and rendered.
            let annot_count = page_obj.annotations().len();
            for i in (0..annot_count).rev() {
                let is_inkwell = if let Ok(annot) = page_obj.annotations().get(i) {
                    annot.creator().as_deref() == Some("Inkwell")
                } else {
                    false
                };
                if is_inkwell {
                    let annots = page_obj.annotations_mut();
                    if let Ok(annot) = annots.get(i) {
                        let _ = annots.delete_annotation(annot);
                    }
                }
            }

            let actual_w = page_obj.width().value as f64;
            let actual_h = page_obj.height().value as f64;
            let target_w = ((actual_w * scale).round().max(1.0) as i32).min(4096);
            let target_h = ((actual_h * scale).round().max(1.0) as i32).min(4096);

            let config = PdfRenderConfig::new()
                .set_target_width(target_w)
                .set_maximum_height(target_h)
                .set_clear_color(PdfColor::WHITE)
                .render_annotations(true);

            let bitmap = page_obj.render_with_config(&config).map_err(|e| {
                format!("PDFium failed to render page {page}: {e:?}")
            })?;

            let bgra = Arc::new(bitmap.as_raw_bytes().to_vec());
            let bw = bitmap.width() as u32;
            let bh = bitmap.height() as u32;

            let mut cache_guard = state.page_bitmap_cache.lock().map_err(|e| format!("Lock error: {e}"))?;
            cache_guard.put(CachedPageBitmap {
                page,
                target_w,
                target_h,
                bgra_bytes: bgra.clone(),
                bitmap_w: bw,
                bitmap_h: bh,
            });

            if let Ok(mut dim_guard) = state.page_dimensions.lock() {
                dim_guard.insert(page, (actual_w, actual_h));
            }

            (bgra, bw, bh)
        }
    };

    // Offload the pixel cropping and alpha blending to a worker thread
    tauri::async_runtime::spawn_blocking(move || {
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
                        let r = bgra_bytes[src_idx];
                        let g = bgra_bytes[src_idx + 1];
                        let b = bgra_bytes[src_idx + 2];
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

        Ok(tauri::ipc::Response::new(rgba_data))
    })
    .await
    .map_err(|e| format!("Tile worker task failed: {e}"))?
}


#[tauri::command]
pub async fn commit_stroke(
    sheet: usize,
    tool: String,
    rgb: [f64; 3],
    base_width: f64,
    samples: Vec<RawSampleInput>,
    client_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;

    let tool_kind = match tool.as_str() {
        "highlighter" => ToolKind::Highlighter,
        _ => ToolKind::Pen,
    };

    let stroke_id = if let Some(ref cid) = client_id {
        parse_stroke_id(cid)
    } else {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    };

    let brush = Brush {
        base_width,
        min_ratio: 0.22,
        gamma: 1.0,
    };

    let raw_pts: Vec<Sample> = samples
        .into_iter()
        .map(|s| Sample::new(s.x, s.y, s.pressure.clamp(0.0, 1.0), s.t_ms))
        .collect();

    let pts = if raw_pts.len() > 3 {
        inkwell_core::ink::simplify(&raw_pts, 0.4)
    } else {
        raw_pts
    };

    let stroke = Stroke {
        id: stroke_id,
        kind: tool_kind,
        rgb: [rgb[0], rgb[1], rgb[2]],
        brush,
        samples: pts,
    };

    doc.push_stroke(sheet, stroke.clone());

    // Offload WAL append to background worker thread channel.
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::Added { sheet, stroke }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(client_id.unwrap_or_else(|| stroke_id.to_string()))
}

fn frontend_stroke_to_core(fs: &FrontendStroke) -> Option<Stroke> {
    let id = parse_stroke_id(&fs.id);
    let kind = match fs.kind.as_str() {
        "highlighter" => ToolKind::Highlighter,
        _ => ToolKind::Pen,
    };
    let brush = Brush {
        base_width: fs.base_width,
        gamma: 1.0,
        min_ratio: if kind == ToolKind::Highlighter { 1.0 } else { 0.22 },
    };
    let raw_samples: Vec<Sample> = fs.points.iter().map(|p| Sample {
        x: p.x,
        y: p.y,
        p: p.p,
        t: p.t,
    }).collect();

    let samples = if raw_samples.len() > 3 {
        inkwell_core::ink::simplify(&raw_samples, 0.4)
    } else {
        raw_samples
    };

    Some(Stroke {
        id,
        kind,
        rgb: fs.rgb,
        brush,
        samples,
    })
}

#[tauri::command]
pub async fn delete_stroke(stroke_id_str: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;

    let id = parse_stroke_id(&stroke_id_str);
    let removed = doc.remove_stroke(id);
    if removed {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            let _ = tx.send(WalOp::Append(WalEntry::Removed(id)));
        }
        state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(removed)
}

#[tauri::command]
pub async fn journal_image_mutation(
    op: String,
    image: Option<FrontendImage>,
    image_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        if op == "add" || op == "upsert" {
            if let Some(img) = image {
                let _ = tx.send(WalOp::Append(WalEntry::ImageAdded {
                    sheet: img.sheet,
                    id: img.id,
                    x: img.x,
                    y: img.y,
                    width: img.width,
                    height: img.height,
                    data_url: img.data_url,
                }));
            }
        } else if op == "remove" || op == "delete" {
            if let Some(id) = image_id {
                let _ = tx.send(WalOp::Append(WalEntry::ImageRemoved { id }));
            }
        }
    }
    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
pub async fn journal_text_mutation(
    op: String,
    text: Option<FrontendText>,
    text_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        if op == "add" || op == "upsert" {
            if let Some(t) = text {
                let _ = tx.send(WalOp::Append(WalEntry::TextUpsert {
                    sheet: t.sheet,
                    id: t.id,
                    x: t.x,
                    y: t.y,
                    text: t.text,
                    font_size: t.font_size,
                    color: t.color,
                    bold: t.bold,
                    italic: t.italic,
                    width: t.width,
                    height: t.height,
                }));
            }
        } else if op == "remove" || op == "delete" {
            if let Some(id) = text_id {
                let _ = tx.send(WalOp::Append(WalEntry::TextRemoved { id }));
            }
        }
    }
    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
pub async fn save_pdf(
    out_path_str: Option<String>,
    images: Option<Vec<inkwell_pdf::ImageAnnotation>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // If frontend provided the active stroke list, sync doc state completely
    if let Some(ref stroke_list) = strokes {
        for fs in stroke_list {
            if fs.sheet > 10_000 {
                return Err("stroke sheet index out of bounds".to_string());
            }
        }
        let mut doc_guard = state.doc.lock().unwrap();
        if let Some(doc) = doc_guard.as_mut() {
            for sheet in &mut doc.sheets {
                for layer in &mut sheet.layers {
                    layer.strokes.clear();
                }
            }
            for fs in stroke_list {
                if !fs.deleted {
                    if let Some(core_stroke) = frontend_stroke_to_core(fs) {
                        while doc.sheets.len() <= fs.sheet {
                            doc.sheets.push(inkwell_core::doc::Sheet::bounded(doc.sheets.len()));
                        }
                        if doc.sheets[fs.sheet].layers.is_empty() {
                            doc.sheets[fs.sheet].layers.push(inkwell_core::doc::Layer::new("Ink"));
                        }
                        doc.sheets[fs.sheet].layers[0].strokes.push(core_stroke);
                    }
                }
            }
            doc.reindex_bounded_sheets();
        }
    }

    let doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_ref().ok_or("No document open")?;

    // Use the original pristine PDF bytes as the base for image and text embedding.
    // This prevents compounding duplicate objects across save cycles.
    let orig_guard = state.original_pdf_bytes.lock().unwrap();
    let original_bytes = orig_guard.as_ref().ok_or("No original PDF loaded")?;

    let target_path = if let Some(p) = out_path_str {
        let path = PathBuf::from(&p);
        if p.contains("..") || path.components().any(|c| c == std::path::Component::ParentDir) {
            return Err("Path traversal components (..) are not permitted in save path".to_string());
        }
        let is_pdf = path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false);
        if !is_pdf {
            return Err("Invalid save path: destination file must have a .pdf extension".to_string());
        }
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                return Err(format!("Parent directory does not exist: {parent:?}"));
            }
        }
        path
    } else {
        state.pdf_path.lock().map_err(|e| format!("Lock error: {e}"))?.clone().ok_or("No target file path")?
    };

    // 1. If images were provided, embed them into the ORIGINAL base PDF using PDFium.
    let base_with_images = if let Some(ref img_list) = images {
        if !img_list.is_empty() {
            let pdfium_guard = state.pdfium.lock().unwrap();
            let pdfium = pdfium_guard.as_ref().ok_or("PDFium is unavailable for image embedding")?;
            inkwell_pdf::embed_images_in_pdf(pdfium, original_bytes, img_list)
                .map_err(|e| format!("Failed to embed images in PDF: {e:?}"))?
        } else {
            original_bytes.to_vec()
        }
    } else {
        original_bytes.to_vec()
    };

    // 2. If sticky note text objects were provided, embed them as real PDF text objects.
    let base_with_texts = if let Some(ref text_list) = texts {
        if !text_list.is_empty() {
            let annotations: Vec<inkwell_pdf::TextAnnotation> = text_list.iter()
                .filter(|t| !t.text.trim().is_empty())
                .map(|t| inkwell_pdf::TextAnnotation {
                    sheet: t.sheet,
                    x: t.x,
                    y: t.y,
                    text: t.text.clone(),
                    font_size: t.font_size,
                    color: t.color.clone(),
                    bold: t.bold,
                    italic: t.italic,
                }).collect();
            let pdfium_guard = state.pdfium.lock().unwrap();
            let pdfium = pdfium_guard.as_ref()
                .ok_or("PDFium is unavailable for text embedding")?;
            inkwell_pdf::embed_texts_in_pdf(pdfium, &base_with_images, &annotations)
                .map_err(|e| format!("Failed to embed text in PDF: {e:?}"))?
        } else {
            base_with_images
        }
    } else {
        base_with_images
    };

    // 3. Open PDF and append vector ink layers
    let (_norm_bytes, mut pdf_file) = match PdfFile::open(base_with_texts.clone()) {
        Ok(f) => (base_with_texts.clone(), f),
        Err(e) => {
            eprintln!("[inkwell] Base PDF requires normalisation for writing ({e:?})...");
            let pdfium_guard = state.pdfium.lock().unwrap();
            let pdfium = pdfium_guard.as_ref().ok_or_else(|| {
                format!("Failed to open base PDF ({e}) and PDFium is unavailable for normalisation.")
            })?;
            let nb = inkwell_pdf::normalise(pdfium, &base_with_texts)
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

    // Update in-memory state with the written PDF bytes
    drop(orig_guard);
    drop(doc_guard);
    *state.pdf_bytes.lock().unwrap() = Some(Arc::new(final_bytes));

    let is_save_as = {
        let current_path = state.pdf_path.lock().unwrap();
        current_path.as_ref() != Some(&target_path)
    };
    *state.pdf_path.lock().unwrap() = Some(target_path.clone());

    if is_save_as {
        if let Some(old_tx) = state.wal.lock().unwrap().take() {
            let _ = old_tx.send(WalOp::Close);
        }
        let wp = wal_path_for(&target_path);
        match Wal::open(&wp) {
            Ok(wal) => {
                let tx = init_wal_worker(wal);
                *state.wal.lock().unwrap() = Some(tx);
            }
            Err(e) => {
                eprintln!("[inkwell] WAL init failed for Save As ({wp:?}): {e}");
            }
        }
    }

    state.is_dirty.store(false, std::sync::atomic::Ordering::Relaxed);

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Truncate);
    }

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_pdf_dialog(
    images: Option<Vec<inkwell_pdf::ImageAnnotation>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let file_option = tauri::async_runtime::spawn_blocking(move || {
        window.dialog()
            .file()
            .add_filter("PDF Document", &["pdf"])
            .set_file_name("Untitled.pdf")
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(path) = file_option {
        let path_buf = path.into_path().map_err(|e| e.to_string())?;
        let path_str = path_buf.to_string_lossy().to_string();
        save_pdf(Some(path_str), images, strokes, texts, state).await
    } else {
        Err("CANCELLED".to_string())
    }
}

#[tauri::command]
pub async fn erase_strokes_near(
    sheet: usize,
    px: f64,
    py: f64,
    radius: f64,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    let removed = doc.erase_strokes_near(sheet, px, py, radius);
    if !removed.is_empty() {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            for &id in &removed {
                let _ = tx.send(WalOp::Append(WalEntry::Removed(id)));
            }
        }
        state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(removed.into_iter().map(|id| id.to_string()).collect())
}

#[tauri::command]
pub async fn erase_strokes_in_rect(
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
    if !removed.is_empty() {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            for &id in &removed {
                let _ = tx.send(WalOp::Append(WalEntry::Removed(id)));
            }
        }
        state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(removed.into_iter().map(|id| id.to_string()).collect())
}

#[tauri::command]
pub async fn get_document_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_ref().ok_or("No document open")?;

    Ok(serde_json::json!({
        "sheets": doc.sheets.len(),
        "strokes": doc.stroke_count(),
        "samples": doc.sample_count(),
    }))
}

#[tauri::command]
pub async fn insert_blank_page(
    index: usize,
    width_pt: f64,
    height_pt: f64,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
    if !width_pt.is_finite() || !height_pt.is_finite() || width_pt < 72.0 || height_pt < 72.0 || width_pt > 14400.0 || height_pt > 14400.0 {
        return Err(format!("Invalid page dimensions: {width_pt} x {height_pt} pt (must be between 72 and 14400)"));
    }

    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;

    doc.insert_sheet(index);

    // If we have base PDF bytes, insert a blank page into the PDF bytes as well
    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available for page insertion")?;
        use pdfium_render::prelude::*;
        let mut pdf_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
            .map_err(|e| format!("PDFium failed to load PDF for page insertion: {e:?}"))?;
        let w = PdfPoints::new(width_pt as f32);
        let h = PdfPoints::new(height_pt as f32);
        let target_idx = (index as i32).min(pdf_doc.pages().len());
        pdf_doc.pages_mut().create_page_at_index(
            PdfPagePaperSize::Custom(w, h),
            target_idx,
        ).map_err(|e| format!("PDFium create_page_at_index failed: {e:?}"))?;
        let new_bytes = pdf_doc.save_to_bytes()
            .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
        *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
        *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
    }

    state.page_bitmap_cache.lock().unwrap().clear();

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageInserted {
            index,
            width_pt,
            height_pt,
        }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);

    Ok(PageInfo {
        page_index: index,
        width_pt,
        height_pt,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResultItem {
    pub page_index: usize,
    pub snippet: String,
    pub match_count: usize,
}

#[tauri::command]
pub async fn search_pdf(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResultItem>, String> {
    let query_trimmed = query.trim();
    if query_trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let bytes = state
        .pdf_bytes
        .lock()
        .unwrap()
        .clone()
        .ok_or("No PDF loaded")?;

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let mut results = Vec::new();
    let q_lower = query_trimmed.to_lowercase();
    let n_pages = doc.pages().len() as usize;

    for i in 0..n_pages {
        if let Some(text) = inkwell_pdf::extract_text(&doc, i as u32) {
            let text_chars: Vec<char> = text.chars().collect();
            let text_lower: String = text_chars.iter().collect::<String>().to_lowercase();
            let text_lower_chars: Vec<char> = text_lower.chars().collect();
            let q_chars: Vec<char> = q_lower.chars().collect();

            if !q_chars.is_empty() {
                if let Some(char_idx) = text_lower_chars.windows(q_chars.len()).position(|w| w == q_chars.as_slice()) {
                    let start = char_idx.saturating_sub(40).min(text_chars.len());
                    let end = (char_idx + q_chars.len() + 40).min(text_chars.len()).max(start);
                    let snippet_str: String = text_chars[start..end].iter().collect();
                    let snippet = format!(
                        "{}{}{}",
                        if start > 0 { "…" } else { "" },
                        snippet_str.replace('\n', " "),
                        if end < text_chars.len() { "…" } else { "" }
                    );
                    let match_count = text_lower_chars.windows(q_chars.len()).filter(|w| *w == q_chars.as_slice()).count();
                    results.push(SearchResultItem {
                        page_index: i,
                        snippet,
                        match_count,
                    });
                }
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn get_page_text_spans(
    page_index: usize,
    state: State<'_, AppState>,
) -> Result<Vec<inkwell_pdf::TextSpan>, String> {
    let bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let Some(bytes) = bytes_opt else {
        return Ok(Vec::new());
    };

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    Ok(inkwell_pdf::extract_text_spans(&doc, page_index as u32))
}

#[tauri::command]
pub async fn get_page_text_data(
    page_index: usize,
    state: State<'_, AppState>,
) -> Result<inkwell_pdf::PageTextData, String> {
    let bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let Some(bytes) = bytes_opt else {
        return Ok(inkwell_pdf::PageTextData {
            page_index,
            text: String::new(),
            lines: Vec::new(),
            chars: Vec::new(),
            spans: Vec::new(),
        });
    };

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    Ok(inkwell_pdf::extract_page_text_data(&doc, page_index as u32))
}

#[tauri::command]
pub async fn get_pdf_outline(state: State<'_, AppState>) -> Result<Vec<inkwell_pdf::TocItem>, String> {
    let bytes = state
        .pdf_bytes
        .lock()
        .unwrap()
        .clone()
        .ok_or("No PDF loaded")?;

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    Ok(inkwell_pdf::extract_outline(&doc))
}

#[tauri::command]
pub async fn switch_document_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut active_id_guard = state.active_session_id.lock().unwrap();
    let mut sessions_guard = state.sessions.lock().unwrap();

    if let Some(ref current_id) = *active_id_guard {
        if current_id == &session_id {
            return Ok(true);
        }
        if let Some(session) = sessions_guard.get_mut(current_id) {
            if let Some(doc) = state.doc.lock().unwrap().take() {
                session.doc = doc;
            }
            session.pdf_path = state.pdf_path.lock().unwrap().clone();
            session.pdf_bytes = state.pdf_bytes.lock().unwrap().clone();
            session.original_pdf_bytes = state.original_pdf_bytes.lock().unwrap().clone();
            session.wal = state.wal.lock().unwrap().take();
            std::mem::swap(&mut session.page_bitmap_cache, &mut *state.page_bitmap_cache.lock().unwrap());
            std::mem::swap(&mut session.page_dimensions, &mut *state.page_dimensions.lock().unwrap());
        }
    }

    if let Some(target) = sessions_guard.get_mut(&session_id) {
        *state.doc.lock().unwrap() = Some(target.doc.clone());
        *state.pdf_path.lock().unwrap() = target.pdf_path.clone();
        *state.pdf_bytes.lock().unwrap() = target.pdf_bytes.clone();
        *state.original_pdf_bytes.lock().unwrap() = target.original_pdf_bytes.clone();
        *state.wal.lock().unwrap() = target.wal.take();
        std::mem::swap(&mut target.page_bitmap_cache, &mut *state.page_bitmap_cache.lock().unwrap());
        std::mem::swap(&mut target.page_dimensions, &mut *state.page_dimensions.lock().unwrap());
        *active_id_guard = Some(session_id);
        Ok(true)
    } else {
        *active_id_guard = Some(session_id);
        Ok(false)
    }
}

#[tauri::command]
pub async fn close_document_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut sessions_guard = state.sessions.lock().unwrap();
    if let Some(mut session) = sessions_guard.remove(&session_id) {
        if let Some(tx) = session.wal.take() {
            let _ = tx.send(crate::state::WalOp::Close);
        }
    }
    let mut active_id_guard = state.active_session_id.lock().unwrap();
    if active_id_guard.as_ref() == Some(&session_id) {
        *active_id_guard = None;
    }
    Ok(true)
}

#[tauri::command]
pub async fn delete_page(
    index: usize,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    if !doc.delete_sheet(index) {
        return Err(format!("Cannot delete page {index} (page out of bounds or only remaining page)"));
    }

    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            let src_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load PDF for page deletion: {e:?}"))?;
            let total_pages = src_doc.pages().len();
            let mut dest_doc = pdfium.create_new_pdf()
                .map_err(|e| format!("PDFium create_new_pdf failed: {e:?}"))?;
            
            if index > 0 {
                dest_doc.pages_mut().copy_page_range_from_document(
                    &src_doc,
                    0..=(index as i32 - 1),
                    0,
                ).map_err(|e| format!("PDFium copy before failed: {e:?}"))?;
            }
            if (index as i32 + 1) < total_pages {
                let dest_len = dest_doc.pages().len();
                dest_doc.pages_mut().copy_page_range_from_document(
                    &src_doc,
                    (index as i32 + 1)..=(total_pages - 1),
                    dest_len,
                ).map_err(|e| format!("PDFium copy after failed: {e:?}"))?;
            }

            let new_bytes = dest_doc.save_to_bytes()
                .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
            *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
            *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
        }
    }

    state.page_bitmap_cache.lock().unwrap().clear();

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageDeleted { index }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
pub async fn duplicate_page(
    index: usize,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    let target_idx = doc.duplicate_sheet(index).ok_or_else(|| format!("Page index {index} out of bounds"))?;

    let mut out_w = 595.0;
    let mut out_h = 842.0;

    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            let src_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load src PDF for duplicate: {e:?}"))?;
            if let Ok(src_page) = src_doc.pages().get(index as i32) {
                out_w = src_page.width().value as f64;
                out_h = src_page.height().value as f64;
            }
            let mut dest_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load dest PDF for duplicate: {e:?}"))?;
            dest_doc.pages_mut().copy_page_from_document(
                &src_doc,
                index as i32,
                target_idx as i32,
            ).map_err(|e| format!("PDFium copy_page_from_document failed: {e:?}"))?;

            let new_bytes = dest_doc.save_to_bytes()
                .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
            *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
            *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
        }
    }

    state.page_bitmap_cache.lock().unwrap().clear();

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageInserted {
            index: target_idx,
            width_pt: out_w,
            height_pt: out_h,
        }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);

    Ok(PageInfo {
        page_index: target_idx,
        width_pt: out_w,
        height_pt: out_h,
    })
}

#[tauri::command]
pub async fn rotate_page(
    index: usize,
    clockwise: bool,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let mut out_w = 595.0;
    let mut out_h = 842.0;

    if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            let mut pdf_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load PDF for rotation: {e:?}"))?;
            if let Ok(mut page) = pdf_doc.pages_mut().get(index as i32) {
                let orig_w = page.width().value as f64;
                let orig_h = page.height().value as f64;
                if clockwise {
                    let _ = page.rotate_clockwise_degrees(90.0);
                } else {
                    let _ = page.rotate_counter_clockwise_degrees(90.0);
                }
                out_w = orig_h;
                out_h = orig_w;
            }
            let new_bytes = pdf_doc.save_to_bytes()
                .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
            *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
            *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
        }
    }

    state.page_bitmap_cache.lock().unwrap().clear();

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageRotated { index, clockwise }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);

    Ok(PageInfo {
        page_index: index,
        width_pt: out_w,
        height_pt: out_h,
    })
}

#[tauri::command]
pub async fn reorder_page(
    from_index: usize,
    to_index: usize,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    if !doc.reorder_sheet(from_index, to_index) {
        return Err("Page indices out of bounds".to_string());
    }

    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            let src_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load src PDF for reorder: {e:?}"))?;
            let total_pages = src_doc.pages().len() as usize;
            let mut page_indices: Vec<i32> = (0..total_pages as i32).collect();
            let moved = page_indices.remove(from_index);
            page_indices.insert(to_index, moved);

            let mut dest_doc = pdfium.create_new_pdf()
                .map_err(|e| format!("PDFium create_new_pdf failed: {e:?}"))?;
            
            for &idx in &page_indices {
                let dest_len = dest_doc.pages().len();
                dest_doc.pages_mut().copy_page_from_document(&src_doc, idx, dest_len)
                    .map_err(|e| format!("PDFium copy failed during reorder: {e:?}"))?;
            }

            let new_bytes = dest_doc.save_to_bytes()
                .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
            *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
            *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
        }
    }

    state.page_bitmap_cache.lock().unwrap().clear();

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageReordered { from_index, to_index }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
pub async fn start_stylus_stream(
    channel: tauri::ipc::Channel<crate::stylus_linux::StylusMessage>,
) -> Result<(), String> {
    let is_running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    crate::stylus_linux::spawn_stylus_worker(channel, is_running);
    Ok(())
}

#[tauri::command]
pub async fn force_close_window(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut wal_guard) = state.wal.lock() {
        if let Some(tx) = wal_guard.take() {
            let _ = tx.send(crate::state::WalOp::Close);
        }
    };
    app_handle.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn set_document_dirty(dirty: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.is_dirty.store(dirty, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}




