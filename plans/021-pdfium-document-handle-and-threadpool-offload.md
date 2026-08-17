# Plan 021: PDFium Document Handle Caching, Sub-Rectangle Rasterization, and Thread Pool Offloading

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1154947..HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell-app/src-tauri/src/state.rs inkwell/crates/inkwell-pdf/src/rasterizer.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `1154947`, 2026-08-14

## Why this matters

Currently, every single tile request (`render_tile`) re-parses the multi-megabyte PDF byte slice from scratch (`pdfium.load_pdf_from_byte_slice`) under a global mutex and executes CPU-intensive rasterization directly on Tokio's async worker threads. Furthermore, it renders full-page multi-gigabyte bitmaps up to 8192x8192 just to crop a 512x512 tile. Offloading rasterization to blocking worker threads (`spawn_blocking`), maintaining open document handles, and rendering sub-rectangle viewports eliminates viewport stutter and prevents out-of-memory crashes on large documents.

## Current state

- `inkwell-app/src-tauri/src/commands.rs:371-380` — `render_tile` acquires `state.pdfium.lock()` and calls `pdfium.load_pdf_from_byte_slice(&arc_bytes, None)` on every tile request.
- `inkwell-app/src-tauri/src/commands.rs:385-415` — Renders the entire full-page bitmap up to 8192x8192 pixels into RAM before cropping the 512x512 tile.
- `inkwell-app/src-tauri/src/commands.rs:343` — `render_tile` runs synchronously inside Tokio's async execution context.
- `inkwell-app/src/js/app.js:241-247` — `fetchTile` catch block triggers `scheduleRedrawTiles()` on render failure, risking recursive infinite retry loops.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test -- --test-threads=1` | exit 0, all 48 tests pass |
| Clippy | `cd inkwell-app/src-tauri; cargo clippy --all-targets` | exit 0, zero warnings |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src-tauri/src/state.rs`
- `inkwell/crates/inkwell-pdf/src/rasterizer.rs`
- `inkwell-app/src/js/app.js` (error handling only)

**Out of scope**:
- `inkwell-core` geometry and tile cache abstractions.

## Git workflow

- Branch: `advisor/021-pdfium-threadpool-and-tile-rendering`
- Commit per step; message style: `perf(pdfium): <description>`

## Steps

### Step 1: Wrap CPU-bound tile rasterization in `tauri::async_runtime::spawn_blocking`

In `inkwell-app/src-tauri/src/commands.rs`:
1. Inside `render_tile`, move PDFium rasterization, buffer transformations, and BGRA-to-RGBA swizzling inside a `tauri::async_runtime::spawn_blocking(move || { ... }).await.map_err(...)` block.
2. Keep mutex locks granular: acquire locks only during the actual rasterization step on the worker thread.

**Verify**: Run `cd inkwell-app/src-tauri; cargo clippy --all-targets` → zero warnings.

### Step 2: Check bitmap cache before re-parsing PDF bytes and optimize sub-rectangle rendering

1. In `commands.rs` in `render_tile`:
   - Check `state.page_bitmap_cache.lock().unwrap().get(page, target_w, target_h)` FIRST before invoking `load_pdf_from_byte_slice`. If the rendered page bitmap exists in cache, crop and return the tile immediately without touching PDFium.
2. In `inkwell/crates/inkwell-pdf/src/rasterizer.rs`:
   - Utilize sub-rectangle rendering bounds or matrix transforms where available to avoid rasterizing off-tile page areas at high zoom levels.

**Verify**: Run `cd inkwell; cargo test -- --test-threads=1` → all 48 tests pass.

### Step 3: Prevent recursive retry storms on tile render failure in frontend

In `inkwell-app/src/js/app.js`:
1. In `fetchTile` (lines 241–248), remove the `scheduleRedrawTiles()` call from the `catch` block.
2. Cache a null/placeholder error entry in `tileCache` or set a backoff timestamp to prevent re-requesting the identical failed tile on subsequent render ticks.

**Verify**: Run `cd inkwell-m0; py -3 test_smoke.py` → 18/18 checks pass.

## Test plan

- Open a large multi-page PDF (`Higher_Math_Bangla_chapter_3.pdf`) and scroll rapidly through pages: tile rendering must stay responsive and not block drawing or UI buttons.
- Zoom in to 400%–800%: tiles must rasterize cleanly without exceeding RAM budgets or freezing the main thread.
- Induce a simulated tile error: application must display the error gracefully without entering an infinite request loop.

## Done criteria

- [ ] `render_tile` runs inside `spawn_blocking`
- [ ] Cached page bitmaps bypass PDFium document parsing completely
- [ ] No recursive `scheduleRedrawTiles` in `fetchTile` catch handler
- [ ] `cd inkwell; cargo test -- --test-threads=1` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- If `spawn_blocking` introduces deadlocks with PDFium single-threaded FFI bindings, ensure all PDFium calls are serialized under the PDFium mutex.
- If memory usage exceeds 500MB during continuous scrolling.

## Maintenance notes

- PDFium FFI is not thread-safe across concurrent threads without separate isolate handles. All PDFium calls must retain the global mutex guard.
