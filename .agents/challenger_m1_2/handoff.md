# Milestone 1 Challenge & Adversarial Verification Report

**Verdict**: `REQUEST_CHANGES`

---

## 1. Observation

### Observation 1: Broken Build / Clippy in `inkwell-app/src-tauri` due to `_disabled_csp` in `tauri.conf.json`
- **Location**: `inkwell-app/src-tauri/tauri.conf.json:23-25`
  ```json
  "security": {
    "_disabled_csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'ipc:';"
  }
  ```
- **Command & Output**: Running `cd inkwell-app/src-tauri; cargo clippy --all-targets` exits with code 1:
  ```
  error: failed to run custom build command for `inkwell-app v0.1.0`
  ...
  unknown field `_disabled_csp`, expected one of `csp`, `dev-csp`, `devCsp`, `freeze-prototype`, `freezePrototype`, `dangerous-disable-asset-csp-modification`, `dangerousDisableAssetCspModification`, `asset-protocol`, `assetProtocol`, `pattern`, `capabilities`, `headers`
  found an unknown configuration field.
  ```
- **Impact**: The Tauri build script fails on strict schema validation; furthermore, CSP security hardening is disabled.

---

### Observation 2: CPU-Bound PDFium Rasterization Is NOT Offloaded to `spawn_blocking`
- **Location**: `inkwell-app/src-tauri/src/commands.rs:373-434`
  ```rust
  let (bgra_bytes, bitmap_w, bitmap_h) = {
      ...
      let pdfium_guard = state.pdfium.lock().map_err(|e| format!("Lock error: {e}"))?;
      let pdfium = pdfium_guard.as_ref().ok_or_else(...)?;

      let doc = pdfium
          .load_pdf_from_byte_slice(&arc_bytes, None)
          .map_err(|e| format!("PDFium load error: {e:?}"))?;

      let page_obj = doc.pages().get(page as i32)...;
      ...
      let bitmap = page_obj.render_with_config(&config)...;
      ...
  };

  // Offload the pixel cropping and alpha swizzling to a worker thread
  tauri::async_runtime::spawn_blocking(move || {
      ...
  })
  ```
- **Analysis**: PDF byte slice parsing (`load_pdf_from_byte_slice`), page object acquisition (`doc.pages().get`), and CPU-intensive PDF rasterization (`page_obj.render_with_config`) execute synchronously on Tokio's async worker thread before `spawn_blocking` is reached. Only the pixel cropping loop (lines 434–479) is offloaded.
- **Impact**: Heavy PDF rendering stalls Tokio's async reactor, violating Plan 021 Step 1 and SCOPE.md Item 6.

---

### Observation 3: Initial Page Bitmap Cache Check Always Misses Due to Page-Width vs Tile-Width Comparison
- **Location**: `inkwell-app/src-tauri/src/commands.rs:375-380`
  ```rust
  if let Ok(cache_guard) = state.page_bitmap_cache.lock() {
      // If target dimensions can be queried from cached entries for this page:
      if let Some(entry) = cache_guard.entries.iter().find(|e| e.page == page && (e.target_w as f64 - rw * scale).abs() < 2.0) {
          cache_hit = Some((entry.bgra_bytes.clone(), entry.bitmap_w, entry.bitmap_h));
      }
  }
  ```
- **Analysis**:
  - `entry.target_w` is the full rendered page width in pixels: `(page_w * scale)` (e.g. 1224 px for a 612 pt page at scale 2.0).
  - `rw * scale` is the tile rectangle width in pixels: `(rect[2] - rect[0]) * scale` (e.g. 512 px for a 256 pt tile).
  - `(1224.0 - 512.0).abs() = 712.0 < 2.0` is `false`.
  - For any sub-rectangle tile where `rw < page_w`, `cache_hit` is **always** `None`.
  - Because `cache_hit` is `None`, `render_tile` enters the `else` branch (lines 385–399) on **every tile request**, locks `state.pdfium`, and calls `pdfium.load_pdf_from_byte_slice(&arc_bytes, None)` and `doc.pages().get(...)` before reaching `cache_guard.get(...)` at line 403.
- **Impact**: The multi-megabyte PDF is re-parsed from raw byte slices under the global PDFium mutex on every single tile, defeating the core objective of Plan 021 Step 2.

---

### Observation 4: Frontend Tile Error Handling in `app.js` Verified Robust
- **Location**: `inkwell-app/src/js/app.js:210-252, 350-432`
- **Behavior**:
  - `fetchTile` catch handler sets `tileCache.set(key, null);` and does not call `scheduleRedrawTiles()`.
  - `drawTileData` guards `if (!data) return;`.
  - `redrawTilesForPage` checks `if (tileCache.has(trKey)) { await drawTileData(tileCache.get(trKey), ...); return; }`.
  - Future redraw ticks find the key in `tileCache`, skip re-fetching, and draw nothing without triggering recursive IPC requests or loop storms.
- **Status**: PASSED.

---

### Observation 5: Security Hardening Features Verified
- **Unicode Search Slicing** (`commands.rs:806-825`): Character array window indexing prevents UTF-8 byte boundary panics. Verified via `test_unicode_search_window_slicing_safety`.
- **DLL Search Restriction** (`inkwell-pdf/src/lib.rs:18-60`): `current_dir()` search removed; bounded to executable parent dir, `PDFIUM_DLL_DIR`, and system bindings.
- **Bounds Checking & Varint Guards** (`codec.rs:89-105`, `pdfobj.rs:94-194`): Allocations bounded to `.min(1024)`; varint shifts guarded against `shift >= 64`.
- **Path Validation** (`commands.rs:563-579`): `..` components rejected, `.pdf` extension enforced, parent directory verified.
- **Status**: PASSED.

---

## 2. Logic Chain

1. **Clippy Failure**: `tauri.conf.json` contains `_disabled_csp` which is not a recognized field in the Tauri v2 schema. `tauri-build` fails during compilation. Changing `_disabled_csp` to `csp` fixes the schema validation and enables the intended CSP security header.
2. **Async Thread Blocking**: Tokio async threads are designed for non-blocking I/O. Executing PDFium rasterization synchronously inside `render_tile` starves Tokio workers of CPU time during high tile load. Offloading both PDFium document loading/rendering and pixel cropping into `tauri::async_runtime::spawn_blocking` frees Tokio threads.
3. **Cache Miss Storm**: `entry.target_w` represents the full page pixel width, while `rw * scale` represents the tile pixel width. Because tile width is smaller than page width, `(entry.target_w as f64 - rw * scale).abs() < 2.0` always fails. Storing `page_w` / `page_h` on `CachedPageBitmap` or matching `entry.target_w == ((page_w * scale).round() as i32)` allows direct cache hits without invoking `load_pdf_from_byte_slice`.

---

## 3. Caveats

- Rust core unit/integration tests in `inkwell/` pass (51/51), but `inkwell-app/src-tauri` clippy fails due to the `tauri.conf.json` field name.
- Playwright smoke test (`inkwell-m0/test_smoke.py`) tests the M0 prototype frontend and passes 18/18, but does not test Tauri backend IPC commands.

---

## 4. Conclusion

**Verdict: `REQUEST_CHANGES`**

The following three remediation items must be resolved by the worker agent:

1. **Fix `tauri.conf.json`**: Rename `"_disabled_csp"` to `"csp"` so `cd inkwell-app/src-tauri; cargo clippy --all-targets` succeeds and CSP is enforced.
2. **Offload PDFium Rasterization inside `spawn_blocking`**: Move `load_pdf_from_byte_slice` and `render_with_config` into `tauri::async_runtime::spawn_blocking` so CPU rendering does not block the async executor thread.
3. **Fix `PageBitmapLruCache` Dimension Match in `commands.rs`**: Store `page_w_pt` and `page_h_pt` in `CachedPageBitmap` (or compute `target_w = ((entry.page_w_pt * scale).round() as i32)` from the cache entry) so sub-tiles hit the cache directly without calling `load_pdf_from_byte_slice` on every tile.

---

## 5. Verification Method

To verify the fixes:

1. **Tauri Clippy**:
   ```powershell
   cd inkwell-app/src-tauri; cargo clippy --all-targets
   ```
   *Expected*: Exit code 0 with zero warnings/errors.

2. **Rust Core Tests**:
   ```powershell
   cd inkwell; cargo test -- --test-threads=1
   ```
   *Expected*: Exit code 0, 51/51 tests pass.

3. **Smoke Tests**:
   ```powershell
   cd inkwell-m0; py -3 test_smoke.py
   ```
   *Expected*: Exit code 0, 18/18 checks pass.

4. **Cache & Threadpool Invalidation Condition**:
   - `render_tile` must not call `load_pdf_from_byte_slice` when a valid page bitmap for `page` and `scale` already exists in `page_bitmap_cache`.
   - `render_with_config` must execute inside `spawn_blocking`.
