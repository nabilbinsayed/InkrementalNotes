# Original User Request

## Initial Request — 2026-09-02T10:45:08Z

<USER_REQUEST>
Optimize the entire InkWell codebase for maximum performance and responsiveness, fix broken or misbehaving canvas tools (such as text selection and spacebar quick-toggling between the last two active tools), polish UI/UX, and ensure robust build and runtime stability across both Windows and Linux without cross-platform regressions.

Working directory: /mnt/Work/Own Programs/InkWell
Integrity mode: development

## Requirements

### R1. Cross-Platform Build & Runtime Stability
Ensure seamless compilation, dynamic library linking, and error-free runtime execution across both Linux (Fedora/X11/Wayland) and Windows (MSVC, PDFium DLL resolution, paths, and environment) without regressions on either platform.

### R2. Tool Repair & Interaction Polish
Fix all canvas tools to ensure complete functional reliability. Specifically:
- Spacebar interaction: Tapping spacebar toggles immediately between the currently active tool and the previous tool; holding spacebar engages temporary pan mode while pressed.
- Text selection: Ensure text can be accurately selected, highlighted, and copied from PDF text layers and annotations.
- Full toolsuite reliability: Verify and fix Pen, Highlighter, Eraser, Lasso, Shapes, Text/Sticky Notes, and Laser Pointer behaviors and state transitions.

### R3. Performance & UI/UX Optimization
Maximize rendering frame rates, eliminate UI lag during inking, panning, and zooming, eliminate swallowed errors or silent failures, and polish interactive touch/mouse ergonomics.

## Acceptance Criteria

### Cross-Platform & Build
- [ ] Rust workspace tests (`cd inkwell && cargo test --workspace -- --test-threads=1`) pass with 0 failures and 0 panics.
- [ ] Desktop app smoke tests (`cd inkwell-app && py -3 test_app_smoke.py` / `python3 test_app_smoke.py`) pass 100%.
- [ ] Tauri application compiles cleanly on both Linux (`cargo build`) and Windows (`cargo build` / MSVC) with dynamic PDFium library loading verified.
- [ ] Rust clippy (`cargo clippy --all-targets`) runs with zero warnings across all crates.

### Tool & Interaction Functionality
- [ ] Tapping Spacebar switches seamlessly between current tool and the previously used tool without getting stuck in pan state; holding Spacebar initiates temporary pan mode until released.
- [ ] Text selection tool allows drag-selecting text blocks on PDF pages, displays selection bounding highlights, and copies text to clipboard via shortcut or context menu.
- [ ] All primary canvas tools (Pen, Eraser, Highlighter, Lasso, Shapes, Text, Laser) activate, render, and record undo/redo history cleanly without state desynchronization.

### Performance & Quality
- [ ] Smooth, 60+ FPS canvas rendering and low-latency stroke response during intensive drawing, panning, and zooming.
- [ ] Full compliance with core PDF standards, append-only incremental saves, and WAL durability rules specified in `AGENTS.md`.
</USER_REQUEST>
