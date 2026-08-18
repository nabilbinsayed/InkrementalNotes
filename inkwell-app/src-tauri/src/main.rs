// Inkwell production Tauri host.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

use state::AppState;

fn main() {
    // WebView2 tuning, Windows only. Must be set before the webview starts.
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-features=CalculateNativeWinOcclusion,TouchpadOverscrollHistoryNavigation \
         --enable-features=CanvasOopRasterization \
         --disable-renderer-backgrounding \
         --disable-backgrounding-occluded-windows \
         --disable-background-timer-throttling",
    );

    // Initialize PDFium once at startup and store in AppState.
    // All commands that need PDFium will borrow this cached instance.
    let app_state = AppState::default();
    match inkwell_pdf::init_pdfium() {
        Ok(pdfium) => {
            eprintln!("[inkwell] PDFium initialized successfully at startup.");
            *app_state.pdfium.lock().unwrap() = Some(pdfium);
        }
        Err(e) => {
            eprintln!(
                "[inkwell] WARNING: PDFium failed to initialize at startup: {e:?}\n\
                 PDF rendering will not work. Ensure pdfium.dll is next to the executable."
            );
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                use tauri::Manager;
                let state: tauri::State<'_, AppState> = window.state();
                if let Ok(mut wal_guard) = state.wal.lock() {
                    if let Some(tx) = wal_guard.take() {
                        let _ = tx.send(crate::state::WalOp::Close);
                    }
                };
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_pdf,
            commands::open_pdf_dialog,
            commands::open_pdf_bytes,
            commands::create_blank_document,
            commands::render_tile,
            commands::commit_stroke,
            commands::delete_stroke,
            commands::erase_strokes_near,
            commands::erase_strokes_in_rect,
            commands::save_pdf,
            commands::save_pdf_dialog,
            commands::get_document_info,
            commands::insert_blank_page,
            commands::search_pdf,
            commands::get_page_text_spans,
            commands::get_pdf_outline,
            commands::switch_document_session,
            commands::close_document_session,
            commands::delete_page,
            commands::duplicate_page,
            commands::rotate_page,
            commands::reorder_page,
            commands::journal_image_mutation,
            commands::journal_text_mutation,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Inkwell");
}
