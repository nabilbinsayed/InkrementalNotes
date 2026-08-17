# Review & Handoff Report: Milestone 1 (Security Hardening & PDFium Worker Pipeline)

**Verdict**: **APPROVE**

---

## 1. Observation

### Implementation Inspection
1. **Unicode Search Slicing (`inkwell-app/src-tauri/src/commands.rs:777-834`)**:
   - `search_pdf` converts text and queries into `Vec<char>` arrays (`text_chars`, `text_lower_chars`, `q_chars`).
   - Matching is evaluated via character windows `text_lower_chars.windows(q_chars.len()).position(...)`.
   - Snippet boundaries are clamped against the character vector length: `start = char_idx.saturating_sub(40).min(text_chars.len())`, `end = (char_idx + q_chars.len() + 40).min(text_chars.len()).max(start)`.
   - No raw byte slicing or unchecked `&str[start..end]` operations exist in the search pathway.

2. **DLL Hijacking Mitigation (`inkwell/crates/inkwell-pdf/src/lib.rs:18-60`)**:
   - `init_pdfium` eliminates all references to `std::env::current_dir()` and relative paths (`./`, `../`).
   - Search candidates are restricted exclusively to `std::env::current_exe()?.parent()`, `std::env::var("PDFIUM_DLL_DIR")`, and system dynamic library bindings (`Pdfium::bind_to_system_library()`).

3. **Varint & Binary Stream Bounds Checking (`inkwell/crates/inkwell-core/src/codec.rs` & `pdfobj.rs`)**:
   - In `codec.rs:89-104`, `get_uvarint` checks `shift >= 64 || (shift == 63 && (b & 0x7F) > 1)` and returns `Err(CodecError::Truncated)` on overflow.
   - In `codec.rs:157, 181`, `Vec::with_capacity` is bounded with `.min(1024)` to protect against upfront OOM allocation attacks from untrusted headers.
   - In `pdfobj.rs:90-194`, `skip_value` clamps all end offsets using `.min(d.len())`, and escape character parsing checks `j < d.len()` before advancing.

4. **Path Sanitization & Parameter Validation (`inkwell-app/src-tauri/src/commands.rs:252-254, 563-579, 723-725`)**:
   - `save_pdf` validates `out_path_str`: rejects `..` traversal and `Component::ParentDir`, enforces `.pdf` file extension (case-insensitive), and verifies that the destination parent directory exists.
   - `create_blank_document` and `insert_blank_page` assert that dimensions `w` and `h` are finite and clamped between `72.0` pt and `14400.0` pt.

5. **Content Security Policy (`inkwell-app/src-tauri/tauri.conf.json:23-25`)**:
   - Strict CSP configured: `"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'ipc:';"`.

6. **Threadpool Offloading & Page Bitmap Caching (`inkwell-app/src-tauri/src/commands.rs:373-482`, `state.rs:13-58`)**:
   - `render_tile` consults `state.page_bitmap_cache` first, avoiding PDFium document re-parsing when the page bitmap is already in memory.
   - Pixel cropping, BGRA-to-RGBA swizzling, and alpha blending are offloaded to `tauri::async_runtime::spawn_blocking`. Mutex locks are held only during bitmap retrieval/rendering and dropped prior to worker execution.

7. **Frontend Retry Loop Suppression (`inkwell-app/src/js/app.js:241-248`)**:
   - `fetchTile` catch block sets `tileCache.set(key, null)` and deletes `tilesPending.delete(key)` without triggering `scheduleRedrawTiles()`, preventing recursive render storms.

---

## 2. Logic Chain

1. *UTF-8 Slicing*: Rust panics when slicing `&str` on byte boundaries that cut through multi-byte UTF-8 code points. Converting both haystack and needle to `Vec<char>` guarantees that all slice indices represent whole Unicode scalar values, making search operations across Bengali, CJK, Arabic, mathematical symbols, and emoji mathematically immune to slice panics.
2. *DLL Hijacking*: In Windows, loading libraries from the working directory enables arbitrary DLL injection if a user opens a PDF from an untrusted folder (e.g. `Downloads`). Restricting lookup to the executable's installation directory, explicit operator environment variables, and Windows system directories closes the search-order attack vector.
3. *Varint & Capacity Bounds*: Decoding a 64-bit varint requires at most 10 bytes; shifting past 63 bits leads to arithmetic overflow. Unchecked `with_capacity(count)` on crafted varints causes immediate memory allocation panics. Bounding initial allocation to `.min(1024)` allows safe incremental vector growth.
4. *Path Sanitization*: Validating path components against `ParentDir` and checking parent existence prevents unauthorized directory traversal writes.
5. *Non-Blocking Worker Offload*: Offloading CPU-heavy rasterization to `spawn_blocking` keeps Tokio's asynchronous IPC runtime responsive, avoiding UI frame drops during heavy PDF rendering.

---

## 3. Caveats

- `pdfium.dll` must be co-located with the application binary, placed in a path defined by `PDFIUM_DLL_DIR`, or available in system library paths.
- Multi-document tab session state persistence and WAL synchronization are scoped to Milestone 2 (Plan 022).

---

## 4. Conclusion

**Verdict: APPROVE**

The implementation across Milestone 1 satisfies all requirements (F04, F05, F06, F12, F13, F14, F15, F16) and conforms to all rules in `AGENTS.md` and `ORIGINAL_REQUEST.md`. Integrity checks revealed no hardcoded results or dummy implementations. All security boundaries, bounds checks, and threadpool offloads are fully functional and independently verified.

---

## 5. Verification Method

Independent verification was conducted using the following commands:

1. **Rust Core Test Suite**:
   ```bash
   cd inkwell
   cargo test -- --test-threads=1
   ```
   **Result**: 51/51 tests passed (0 failed, 0 ignored). Includes `codec_rejects_overflowing_varint_and_bounds_allocation`, `pdfobj_skip_value_bounds_checks_and_clamps`, and `test_unicode_search_window_slicing_safety`.

2. **Rust Clippy (App & Core)**:
   ```bash
   cd inkwell-app/src-tauri
   cargo clippy --all-targets
   ```
   ```bash
   cd inkwell
   cargo clippy --all-targets
   ```
   **Result**: Exit 0, 0 warnings across all targets.

3. **Playwright Smoke Test**:
   ```bash
   cd inkwell-m0
   py -3 test_smoke.py
   ```
   **Result**: 18/18 checks passed, exit 0, 0 console errors, 0 console warnings.
