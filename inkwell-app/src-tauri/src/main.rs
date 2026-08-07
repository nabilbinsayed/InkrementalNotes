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
        "--disable-features=CalculateNativeWinOcclusion \
         --enable-features=CanvasOopRasterization \
         --disable-renderer-backgrounding \
         --disable-backgrounding-occluded-windows \
         --disable-background-timer-throttling",
    );

    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_pdf,
            commands::commit_stroke,
            commands::delete_stroke,
            commands::get_document_info,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Inkwell");
}
