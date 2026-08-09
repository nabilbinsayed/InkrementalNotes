# Plan 013: PDFium Document Handle Caching & Zero-Copy RGBA Tile Transfer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat db1c3a4..HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0 (System Lag & Instability Root Cause)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `db1c3a4`, 2026-08-09

## Why this matters

Currently, every single 512x512 tile request in `inkwell-app` clones the entire raw PDF byte array in Rust RAM (`state.pdf_bytes.lock().unwrap().cloned()`) and invokes `pdfium.load_pdf_from_byte_slice()` to re-parse the PDF document inside PDFium. For a 20-50MB PDF document, viewing a page with 16 visible tiles causes 16 full-document clones (over 300MB-800MB RAM churn per pan frame) and 16 PDF document parsing passes. In JavaScript, `fetchTile()` loops 262,144 times per tile converting RGB bytes into RGBA and creating temporary DOM `<canvas>` elements. This is the main source of the severe system lag and stutter reported by the user.

By storing a thread-safe cached `PdfDocument` handle (or caching page bounds & reusing PDFium document instances across tile requests) and returning RGBA byte buffers directly from Rust (`px * px * 4`), JavaScript can perform zero-copy tile blitting using `new ImageData(new Uint8ClampedArray(raw.buffer), tileW, tileH)` without JS loops or canvas creation.

## Current state

- `inkwell-app/src-tauri/src/commands.rs:180-200`: `render_tile` clones `state.pdf_bytes` and loads the PDF document from bytes per tile request:
  ```rust
  let bytes = state.pdf_bytes.lock().unwrap().as_ref().cloned().ok_or("No PDF loaded")?;
  let pdfium_guard = state.pdfium.lock().unwrap();
  let doc = pdfium.load_pdf_from_byte_slice(&bytes, None)?;
  ```
- `inkwell-app/src/js/app.js:148-157`: `fetchTile()` loops pixel-by-pixel in JS and creates DOM canvas elements:
  ```javascript
  const imgData = new ImageData(tileW, tileH);
  for (let i = 0; i < tileW * tileH; i++) {
    imgData.data[i * 4 + 0] = raw[i * 3 + 0];
    imgData.data[i * 4 + 1] = raw[i * 3 + 1];
    imgData.data[i * 4 + 2] = raw[i * 3 + 2];
    imgData.data[i * 4 + 3] = 255;
  }
  const tileCanvas = document.createElement('canvas');
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust check | `cd inkwell-app/src-tauri && cargo check` | exit 0, no errors |
| Rust test | `cd inkwell && cargo test --workspace` | exit 0, 46 tests pass |
| Python validator | `py -3 tools/validate.py` | exit 0, 24/24 pass |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/app.js`

**Out of scope**:
- `inkwell/crates/inkwell-core/` (core geometry/WAL logic is solid)
- `inkwell-app/src/index.html`

## Steps

### Step 1: Return RGBA bytes from Rust `render_tile` to eliminate JS loop

In `inkwell-app/src-tauri/src/commands.rs`:
1. Update `render_tile()` so that output tile byte buffers format 4 channels (RGBA) per pixel (`expected_len = px as usize * px as usize * 4`).
2. When converting PDFium rasterizer output (RGB) to tile bytes, convert to RGBA (`[r, g, b, 255]`) directly in Rust before returning to Tauri IPC.

**Verify**: `cd inkwell-app/src-tauri && cargo check` -> exit 0.

### Step 2: Implement zero-copy ImageData construction in `app.js`

In `inkwell-app/src/js/app.js`:
1. Update `fetchTile()` to receive RGBA bytes (`expectedBytes = tileW * tileH * 4`).
2. Replace the JS `for` loop and temporary DOM `<canvas>` instantiation with direct `Uint8ClampedArray` typed array view and `ImageData` / `ImageBitmap` creation:
   ```javascript
   const rgbaArray = new Uint8ClampedArray(raw.buffer || raw);
   const imgData = new ImageData(rgbaArray, tileW, tileH);
   tileCache.set(key, imgData);
   ```
3. Update `tctx.drawImage()` / `tctx.putImageData()` calls in `redrawTilesForPane()` to render `ImageData` or `ImageBitmap` directly onto `tilesCanvas`.

**Verify**: Run `py -3 tools/validate.py` -> exit 0.

### Step 3: Cache loaded `PdfDocument` instance in `AppState` or avoid byte cloning

In `inkwell-app/src-tauri/src/commands.rs`:
1. Avoid cloning `Vec<u8>` on every tile request: pass a reference or borrow `&bytes` from `state.pdf_bytes.lock().unwrap()` without calling `.cloned()`.
2. Keep the loaded PDFium document bound or reuse the PDFium document handle in `AppState` so `load_pdf_from_byte_slice` is not called per tile request.

**Verify**: `cd inkwell-app/src-tauri && cargo check` -> exit 0.

## Test plan

- Test opening `fixtures/lecture.pdf` using Tauri IPC and verifying that tiles render smoothly without lag or memory leaks.
- Verification command: `cd inkwell && cargo test --workspace` -> 46 tests pass.

## Done criteria

- [ ] `cargo check` in `inkwell-app/src-tauri` exits 0.
- [ ] No JS `for` pixel unpacking loop remains in `app.js`.
- [ ] Tile IPC returns RGBA bytes directly (`tileW * tileH * 4`).
- [ ] `plans/README.md` updated.

## STOP conditions

- If PDFium lifetime bounds prevent storing `PdfDocument` across async commands in `AppState`, use shared `Arc<Vec<u8>>` bytes to avoid vector cloning and report.

## Maintenance notes

- Future tile cache optimizations should preserve the 4-channel RGBA memory layout.
