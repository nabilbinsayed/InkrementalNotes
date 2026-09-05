# Plan 057: Windows WebView2 DirectManipulation Touchpad Pinch-to-Zoom

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none
- **Category**: platform-limitation / hardware-touchpad
- **Status**: UNFIXED
- **Planned at**: commit `HEAD`, 2026-09-05

## Problem Summary

On Windows hardware using precision touchpads, pinch-to-zoom gestures do not scale the document viewport.

While synthetic DOM tests (e.g. Playwright dispatching `WheelEvent` with `ctrlKey: true` and `deltaMode: 0`) pass and confirm mathematical and viewport zooming integrity in `viewport.js`, real Windows precision touchpad pinch gestures fail to trigger zoom inside the Tauri v2 WebView2 window.

## Root Cause Analysis

1. **DirectManipulation Host Interception**:
   In Microsoft Edge WebView2 on Windows, multi-finger pinch gestures on precision touchpads are intercepted by the OS DirectManipulation engine before DOM events are dispatched to the web content.
2. **Missing Host Configuration**:
   Unless `ICoreWebView2Settings::put_IsPinchZoomEnabled(FALSE)` or native DirectManipulation hooks are configured on the Windows WebView2 environment in Rust (`src-tauri`), WebView2 does not translate the native pinch gesture into synthetic wheel events or pinch pointer events for the document.
3. **Synthetic DOM vs. Hardware Discrepancy**:
   `inkwell-app/src/js/viewport.js` includes full pinch-to-zoom handling for:
   - `WheelEvent` with `ctrlKey: true` (`deltaY * scaleFactor` continuous exponential zoom).
   - Multi-touch Pointer Events (`pointerdown`, `pointermove` with 2 tracked touch pointers).
   - WebKit/Safari native gesture events (`gesturestart`, `gesturechange`, `gestureend`).
   However, Windows WebView2 precision touchpad hardware bypasses these DOM hooks entirely due to the host-level DirectManipulation capture.

## Current State

- Viewport pinch-to-zoom mathematics and pointer events are implemented in `inkwell-app/src/js/viewport.js`.
- Explicit comment added in `inkwell-app/src/js/viewport.js`:
  ```javascript
  // NOTE: Windows WebView2 Precision Touchpad Pinch-to-Zoom is currently UNSOLVED / UNFIXED.
  // DirectManipulation intercepts pinch gestures at the OS/WebView2 host level before they
  // reach the DOM as WheelEvent or TouchEvent.
  ```
- Synthetic smoke test in `inkwell-app/test_app_smoke.py` validates that DOM wheel events with `ctrlKey` zoom predictably.
- Real hardware pinch-to-zoom on Windows precision touchpad remains **UNSOLVED**.

## Future Remediation Path

To solve this properly on Windows:
1. In `inkwell-app/src-tauri/src/main.rs`, access the native `webview2` controller via Tauri's Windows webview builder (`tauri::WebviewWindowBuilder` or `tauri_plugin_webview` Windows-specific hooks).
2. Configure `CoreWebView2Settings.IsPinchZoomEnabled = false` to prevent DirectManipulation consumption, allowing pinch gestures to bubble as `WheelEvent` with `ctrlKey: true`.
3. Alternatively, implement a low-level Windows gesture hook (`WM_GESTURE` or `WM_POINTER`) and emit a custom IPC event to Tauri's webview.
