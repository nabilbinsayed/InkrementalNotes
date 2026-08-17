# Scope: Milestone 1 — Security Hardening & PDFium Worker Pipeline

## Objective
Implement comprehensive security hardening, bounds checking, path validation, CSP policy, safe Unicode slicing, non-blocking PDFium tile rendering with `spawn_blocking`, memory-budgeted page bitmap LRU caching, and frontend retry loop guards.

## Features & Plans Covered
- **Features**: F04 (Non-blocking tile rendering), F05 (Sub-rectangle tile rasterization), F06 (Memory-budgeted bitmap cache), F12 (Safe Unicode PDF search slicing), F13 (PDFium DLL search restriction), F14 (Varint & binary bounds checking), F15 (Path traversal sanitization), F16 (Tauri CSP hardening).
- **Plans**: `plans/021-pdfium-document-handle-and-threadpool-offload.md`, `plans/023-security-hardening-utf8-dll-csp-and-path-validation.md`.

## Detailed Work Items
1. **Safe Unicode character-window slicing in PDF search** (`inkwell-app/src-tauri/src/commands.rs` in `search_pdf`):
   - Prevent byte slice panics on multi-byte UTF-8 Unicode characters by collecting `chars()` and finding boundaries on char index offsets.
2. **PDFium DLL search path restriction** (`inkwell/crates/inkwell-pdf/src/lib.rs` in `init_pdfium`):
   - Remove `current_dir()` search and relative `./` paths to prevent DLL search-order hijacking.
   - Restrict to executable directory (`current_exe()?.parent()`), `PDFIUM_DLL_DIR`, or system library bindings.
3. **Bounds checking & varint guards** (`inkwell/crates/inkwell-core/src/codec.rs` and `pdfobj.rs`):
   - In `codec.rs`, bound initial `Vec::with_capacity((count as usize).min(1024))` allocations.
   - In `get_uvarint`, return `None` if `shift >= 64` or `shift == 63 && (b & 0x7F) > 1`.
   - In `pdfobj.rs`, clamp `skip_value` end offsets to `d.len()`, and check `j < d.len()` before evaluating escape characters.
4. **Path sanitization for `save_pdf` and `export_pdf`** (`inkwell-app/src-tauri/src/commands.rs`):
   - Validate `out_path_str` is canonical, has no `..` traversal segments, ends in `.pdf` (case-insensitive), and parent exists.
   - Validate `insert_blank_page` and `create_blank_document` dimensions are finite and bounded (72.0 to 14400.0 pt).
5. **Tauri v2 CSP & Capability Hardening** (`inkwell-app/src-tauri/tauri.conf.json`):
   - Set `"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'ipc:';"`
6. **Non-blocking PDFium worker pipeline** (`inkwell-app/src-tauri/src/commands.rs`):
   - Wrap CPU-heavy `render_tile` operations inside `tauri::async_runtime::spawn_blocking(move || { ... }).await.map_err(...)`.
   - Keep mutex locks granular during rasterization.
7. **Memory-budgeted bitmap cache** (`inkwell-app/src-tauri/src/commands.rs` / `state.rs` / `inkwell/crates/inkwell-pdf/src/rasterizer.rs`):
   - Check `state.page_bitmap_cache` first before invoking `load_pdf_from_byte_slice`.
   - Optimize sub-rectangle rendering / matrix transforms where possible.
8. **Single-retry tile request error handling** (`inkwell-app/src/js/app.js` / `viewport.js`):
   - Remove recursive `scheduleRedrawTiles()` from the `fetchTile` catch handler to prevent loop storms.
   - Cache null/placeholder error entry or backoff timer.

## Verification Commands
1. `cd inkwell; cargo test -- --test-threads=1` (All tests must pass)
2. `cd inkwell-app/src-tauri; cargo clippy --all-targets` (Zero warnings)
3. `cd inkwell-m0; py -3 test_smoke.py` (18/18 checks pass)
