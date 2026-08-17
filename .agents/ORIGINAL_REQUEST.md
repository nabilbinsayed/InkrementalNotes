# Original User Request

## Initial Request — 2026-08-14T10:29:48Z

InkWell is a high-performance, PDF-native ink annotator desktop application built with Tauri v2, Rust (`inkwell-core`, `inkwell-pdf`), and Vanilla JS/Canvas. The objective is to eliminate all inking latency, optimize rendering throughput for large documents, harden security and IPC boundaries, fix multi-document data durability, and deliver fluid 120Hz/touch/stylus UX.

Working directory: d:\Own Programs\InkWell
Integrity mode: development

Detailed execution plans with exact file:line evidence are authored and indexed in `plans/README.md` and `plans/020-*.md` through `plans/026-*.md`.

## Requirements

### R1. Zero-Latency Inking & GPU Canvas Optimization
Eliminate all forced synchronous DOM reflows (`getBoundingClientRect`, `updateStats`) and per-sample allocations (`toFixed`, array joins) from the 120Hz–240Hz digitizer event loop. Retain pre-computed `Path2D` vector ribbons, clear only dirty bounding rectangles on pen-up, and ensure sub-1ms pen-tip-to-present processing time. (See `plans/020-pen-latency-dom-layout-and-path2d-caching.md`).

### R2. Non-Blocking PDFium Rendering & Memory-Budgeted Tile Pipeline
Offload CPU-heavy PDFium rasterization to background blocking thread pools (`spawn_blocking`). Prevent redundant PDF byte re-parsing under the global PDFium mutex by caching open document handles in backend sessions. Replace unbudgeted full-page bitmap memory hogs with sub-rectangle tile rasterization and epoch-based request cancellation. (See `plans/021-pdfium-document-handle-and-threadpool-offload.md`).

### R3. Multi-Document Tab Session Synchronization & Data Durability
Refactor backend `AppState` from a single global document to a session-managed map keyed by document ID. Ensure all frontend tab switches, undo/redo operations, lasso deletions/transformations, and pasted objects synchronize atomically with Rust `Document` state and Write-Ahead Log (WAL) journals. Ensure synchronous WAL disk sync and proper window close flushing. (See `plans/022-multi-document-tab-backend-sync-and-state-durability.md`).

### R4. Security Hardening, Safe Slicing & Memory Isolation
Eliminate UTF-8 char-boundary slicing panics in PDF text search. Restrict PDFium DLL loading paths to prevent search-order hijacking. Enforce restrictive Content Security Policy (CSP) in `tauri.conf.json`, sanitize file save paths against directory traversal, and bound all binary varint allocation capacities in `codec.rs` and `pdfobj.rs`. (See `plans/023-security-hardening-utf8-dll-csp-and-path-validation.md`).

### R5. Fluid Motion, Touch/Stylus Ergonomics & Accessibility
Implement palm rejection (ignoring touch during stylus drawing) and multi-touch pinch-to-zoom gesture tracking in `ViewportManager`. Fix CSS drawer transition suppression (`display: none` conflict), preserve laser pointer decay physics, and compute true 45° normal ribbons for the chisel highlighter. Expand all interactive touch targets to at least 44x44px and ensure complete keyboard accessibility and focus trapping on modals. (See `plans/024-touch-stylus-palm-rejection-pinch-zoom-and-fluid-motion.md` & `plans/026-accessibility-touch-targets-focus-traps-and-ux-indicators.md`).

### R6. Spatial Indexing & Viewport Virtualization
Replace O(N*M) linear stroke collision checks in eraser, lasso, and hit testing with stroke AABB bounding box pre-filtering. Virtualize the thumbnail drawer DOM to recycle canvas elements on multi-hundred page documents. (See `plans/025-spatial-indexing-eraser-lasso-and-thumbnail-virtualization.md`).

## Acceptance Criteria

### Performance & Latency
- [ ] Active drawing (`consume` / `onMove`) incurs 0 forced reflows (`getBoundingClientRect`) and 0 DOM mutations per sample.
- [ ] Stroke sampling and color string formatting produce 0 heap allocations in the hot path.
- [ ] `render_tile` runs on a blocking worker thread without blocking Tokio async IPC dispatch.
- [ ] Multi-tile requests reuse cached `PdfDocument` handles without re-parsing PDF bytes per tile.
- [ ] Lasso selection and eraser hit-testing operate in O(1) / O(log N) against stroke AABB bounding boxes.

### Durability & Correctness
- [ ] Switching tabs retains independent document models, WAL journals, and PDF byte buffers on the backend without cross-tab clobbering.
- [ ] Undo and Redo operations update both frontend canvas and backend Rust `Document` / WAL state.
- [ ] Lasso transformations and duplicate/paste operations commit updated coordinates to Rust core and save cleanly to PDF.
- [ ] Blank page insertion during WAL crash recovery restores full page count in `page_infos` and preserves strokes on inserted pages.
- [ ] All 48 existing workspace unit and integration tests (`cd inkwell; cargo test -- --test-threads=1`) pass without failure.

### Security & Hardening
- [ ] PDF search over non-ASCII / Unicode queries executes without UTF-8 slice boundary panics.
- [ ] PDFium loader resolves exclusively to executable/system directories without relative search paths.
- [ ] Malformed or truncated PDF/varint streams cannot trigger out-of-bounds slice panics or unbounded vector allocations.
- [ ] `save_pdf` strictly validates destination paths against directory traversal.
- [ ] Tauri `tauri.conf.json` enforces a strict Content Security Policy.

### UI / UX & Ergonomics
- [ ] Touch events do not clobber active stylus strokes; palm contact is cleanly rejected.
- [ ] Two-finger pinch-to-zoom smoothly zooms and pans the document without drawing stray marks.
- [ ] Navigation drawer slides smoothly with CSS cubic-bezier easing without pop-in or canvas flicker.
- [ ] Chisel highlighter produces consistent-width angled ribbons on horizontal, vertical, and diagonal strokes.
- [ ] All interactive buttons and touch targets satisfy minimum 44x44px touch guidelines.
- [ ] Export modal traps keyboard focus, closes on Escape, and provides visual focus rings.
