# Plan 005: Deep PDFium DLL Search, PDF Normalised Save, and Right Panel UI Toggle

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm expected results. When done, update `plans/README.md`.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-pdf-import-pdfium-fallback.md
- **Category**: bug
- **Planned at**: commit `80d21c6`, 2026-08-08

## Why this matters

1. **PDF Import Failures**: When `inkwell-app.exe` runs inside nested target build directories (e.g. `src-tauri/target/debug`), `init_pdfium()` fails to locate `pdfium.dll` because candidate search paths walk up only 2 levels. When `init_pdfium()` fails, PDFium cannot count pages or render tiles, resulting in 1-page blank documents. Furthermore, `<input type="file">` in `app.js` converts file arrays using `Array.from()`, generating multi-hundred MB JSON IPC payloads that crash WebView2 IPC buffers.
2. **Save Failures**: `save_pdf` in `commands.rs` calls `PdfFile::open(input_bytes)` directly. For PDFs using xref/object streams (most modern PDFs), `PdfFile::open` fails with `XrefStream` or `NoStartxref`, causing saving to fail with a backend error dialog.
3. **Right Panel Toggle**: The user needs a clear, dedicated UI collapse/expand button directly on the right sidebar panel header (`#sidebar`) and stage edge.

## Current state

Files involved:
- `inkwell/crates/inkwell-pdf/src/lib.rs` — `init_pdfium` search path logic (lines 12–51).
- `inkwell-app/src-tauri/src/commands.rs` — `save_pdf` command (lines 251–279).
- `inkwell-app/src/js/app.js` — `pdfFileInput` listener & panel toggle logic.
- `inkwell-app/src/index.html` & `styles.css` — Sidebar panel header & layout.

## Scope

**In scope**:
- `inkwell/crates/inkwell-pdf/src/lib.rs`
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`

## Steps

### Step 1: Deepen `init_pdfium()` search path traversal in `lib.rs`

Walk up to 6 parent directories from `std::env::current_exe()` and `std::env::current_dir()`, checking `pdfium.dll`, `bin/pdfium.dll`, and `src-tauri/pdfium.dll` at every directory level.

### Step 2: Add PDFium normalisation fallback in `save_pdf` in `commands.rs`

Before calling `PdfFile::open(input_bytes.clone())` in `save_pdf`, if `PdfFile::open` returns an error, initialize PDFium and call `inkwell_pdf::normalise(&pdfium, input_bytes)` to produce classic xref bytes for writing vector ink layers.

### Step 3: Use `file.path` in `app.js` for instant PDF opening

In `pdfFileInput` change listener in `app.js`, if `file.path` exists (WebView2 native path), invoke `open_pdf` directly with `{ pathStr: file.path }`.

### Step 4: Add Right Sidebar Panel Collapse/Expand UI Controls

Add a collapse button `▶` to `#sidebar` header in `index.html` and a floating expand button on stage edge in `styles.css`.
