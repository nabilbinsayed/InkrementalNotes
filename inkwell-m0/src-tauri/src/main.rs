// Inkwell M0 — Tauri host.
//
// Deliberately almost empty. At M0 the Rust side does exactly one job: open a
// window with the lowest-latency webview configuration we can get. Every line
// of ink logic lives in ../src so you can also test it by double-clicking
// src/index.html in Edge, with zero toolchain.
//
// From M1 onward this crate grows the PDFium binding, the document model, and
// the WAL. Keep it free of UI logic.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebView2 tuning, Windows only. Must be set before the webview starts.
    //   --disable-features=CalculateNativeWinOcclusion
    //       stops Chromium throttling rendering when it thinks we're occluded
    //   --enable-features=CanvasOopRasterization
    //       keeps canvas raster off the main renderer thread
    //   --disable-renderer-backgrounding / --disable-backgrounding-occluded-windows
    //       stops priority drops that show up as random latency spikes
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
        .run(tauri::generate_context!())
        .expect("failed to start Inkwell M0");
}
