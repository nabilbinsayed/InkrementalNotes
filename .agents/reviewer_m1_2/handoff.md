# Milestone 1: Security Hardening & PDFium Worker Pipeline — Review & Adversarial Report

## Review Summary

**Verdict**: **APPROVE**  
**Integrity Audit**: **PASS** (Zero integrity violations, no dummy facades, no hardcoded cheating, no unverified claims)  
**Security & Stability**: **PASS** (Zero panics, zero clippy warnings, all bounds and paths strictly validated)  

---

## 1. Observation

Direct code verification was conducted across all files modified in Milestone 1:

1. **PDFium DLL Search Path Restriction** (`inkwell/crates/inkwell-pdf/src/lib.rs:18-60`):
   - `std::env::current_dir()` and relative `./`, `../` fallbacks have been completely excised.
   - Dynamic library search is strictly confined to `std::env::current_exe()?.parent()` and subdirectories (`bin`, `src-tauri`), operator-configured `std::env::var("PDFIUM_DLL_DIR")`, or system library bindings (`Pdfium::bind_to_system_library()`).

2. **Varint Shift Guards & Bounded Vector Allocations** (`inkwell/crates/inkwell-core/src/codec.rs:89-105, 156-182`):
   - In `get_uvarint`, bounds check `if shift >= 64 || (shift == 63 && (b & 0x7F) > 1)` returns `Err(CodecError::Truncated)` before evaluating shifts, preventing 64-bit integer overflow.
   - Initial memory allocations in `decode` are strictly bounded: `Vec::with_capacity(count.min(1024))` and `Vec::with_capacity(n.min(1024))`, preventing OOM crashes on crafted payload headers.

3. **PDF Object Scanner Token Bounds & Escape Clamping** (`inkwell/crates/inkwell-core/src/pdfobj.rs:94-198`):
   - `skip_value` enforces `.min(d.len())` bounds clamping on all token parsers (dicts `<<...>>`, hex strings `<...>`, literal strings `(...)`, arrays `[...]`, names `/...`, numeric/keyword tokens).
   - In literal string parsing, backslash escapes check `if j < d.len()` before advancing, preventing buffer overruns on trailing backslashes.

4. **Unicode-Safe PDF Search Window Slicing** (`inkwell-app/src-tauri/src/commands.rs:804-831`):
   - `search_pdf` extracts character vectors via `text.chars().collect::<Vec<char>>()`, lowercases to `Vec<char>`, and matches query substrings using `text_lower_chars.windows(q_chars.len())`.
   - Window slice bounds are calculated on character indices and clamped with `.saturating_sub(40).min(text_chars.len())` and `.min(text_chars.len()).max(start)`, making UTF-8 code point slicing panics impossible.

5. **Path Traversal Sanitization & Dimension Guards** (`inkwell-app/src-tauri/src/commands.rs:563-580, 252-255, 723-726`):
   - `save_pdf` asserts absence of `..` substrings and checks `path.components().any(|c| c == Component::ParentDir)`.
   - Enforces `.pdf` extension (case-insensitive) and validates that parent directories exist.
   - `create_blank_document` and `insert_blank_page` validate that width and height are finite and constrained to `[72.0, 14400.0]` points.

6. **Content Security Policy (CSP)** (`inkwell-app/src-tauri/tauri.conf.json:23-25`):
   - Configured `"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'ipc:';"`.

7. **Worker Pipeline Offloading & LRU Bitmap Cache** (`inkwell-app/src-tauri/src/commands.rs:365-480`):
   - `render_tile` consults `state.page_bitmap_cache` first, avoiding redundant PDF byte re-parsing.
   - Pixel cropping, BGRA-to-RGBA swizzling, and alpha blending are offloaded to `tauri::async_runtime::spawn_blocking`.
   - PDFium mutex guards are scoped and released promptly before async threadpool operations.

8. **Frontend Single-Retry & Error Shielding** (`inkwell-app/src/js/app.js:241-248`):
   - `fetchTile` catch handler sets `tileCache.set(key, null)` and suppresses recursive `scheduleRedrawTiles()` triggers.

9. **Security Unit Tests**:
   - `codec_rejects_overflowing_varint_and_bounds_allocation` in `inkwell-core/tests/integration.rs:108-118`.
   - `pdfobj_skip_value_bounds_checks_and_clamps` in `inkwell-core/tests/integration.rs:121-144`.
   - `test_unicode_search_window_slicing_safety` in `inkwell-pdf/tests/integration.rs:170-195`.

---

## 2. Logic Chain

1. *Memory & Execution Safety*:
   - Unbounded byte-slicing on UTF-8 strings was an active vector for panics when querying non-ASCII text. By operating strictly on character arrays and indexing into `Vec<char>`, string boundary panics are completely eliminated.
   - Varint decoders without shift ceiling checks are vulnerable to integer overflow in debug builds and undefined wrapping in release builds. The `shift >= 64 || (shift == 63 && (b & 0x7F) > 1)` guard is mathematically complete for 64-bit integers.
   - Bounding `Vec::with_capacity` to 1024 elements prevents denial-of-service via memory exhaustion when reading untrusted input streams.

2. *DLL Hijacking Defense*:
   - Windows DLL search order includes the current working directory (`CWD`) if relative paths are queried. By anchoring DLL resolution to the executable parent directory (`std::env::current_exe()?.parent()`) and explicit environment overrides, arbitrary code execution from untrusted document folders is prevented.

3. *IPC & Rendering Concurrency*:
   - PDFium is single-threaded per instance. By executing CPU-heavy rasterization within `spawn_blocking` and caching rendered page bitmaps in `page_bitmap_cache`, the Tokio async reactor remains non-blocking and UI responsiveness is preserved during rapid scrolling.

---

## 3. Adversarial Assessment & Stress Tests

| Challenge Dimension | Scenario / Attack Vector | Defense / Code Behavior | Result |
|---|---|---|---|
| **Varint Shift Overflow** | Stream of 10+ bytes with `0xFF` continuation flags | `get_uvarint` returns `Err(CodecError::Truncated)` at iteration 10 without panic | **PASS** |
| **Shift 63 Overflow** | 9 bytes of `0x80` followed by `0x02` (bit 1 at shift 63) | Guard `shift == 63 && (b & 0x7F) > 1` triggers and returns error | **PASS** |
| **Unbounded Vector OOM** | Header specifying `count = 2^32 - 1` | `with_capacity(count.min(1024))` allocates max 1024 slots initially | **PASS** |
| **Malformed PDF Syntax** | Unterminated dictionaries `<<`, unclosed strings `(.. \`, arrays `[` | `skip_value` clamps cleanly to `d.len()` without out-of-bounds indexing | **PASS** |
| **Unicode Slicing Panics** | Complex Unicode (Bangla conjuncts, emojis, math notation, diacritics) | Character window searching index into `Vec<char>` safely with clamped start/end | **PASS** |
| **Path Traversal** | Save paths such as `../../notes.pdf` or `C:\tmp\..\etc\doc.pdf` | Rejected with traversal error before write attempt | **PASS** |
| **Infinite Error Loops** | Tile rasterization failure | Handled with cached `null` entry and no recursive retry scheduling | **PASS** |

---

## 4. Caveats

- In `inkwell-pdf/src/lib.rs`, line 39 checks for `pdfium.dll` specifically. For Windows desktop targets this is ideal; if macOS or Linux target support is added in the future, the check can use platform-specific naming (`libpdfium.dylib` / `libpdfium.so`).

---

## 5. Conclusion

Milestone 1 satisfies all requirements set forth in Plans 021 and 023 and the sub-orchestrator scope. Implementation quality is high, with no facade code, no bypassed checks, no warnings, and complete test pass coverage.

**Verdict**: **APPROVE**

---

## 6. Verification Method

To independently reproduce verification:
1. **Workspace Test Suite**:
   ```powershell
   cd "d:\Own Programs\InkWell\inkwell"
   cargo test -- --test-threads=1
   ```
   *Outcome*: 51/51 tests pass.
2. **Clippy Linter**:
   ```powershell
   cd "d:\Own Programs\InkWell\inkwell"
   cargo clippy --all-targets
   cd "d:\Own Programs\InkWell\inkwell-app\src-tauri"
   cargo clippy --all-targets
   ```
   *Outcome*: 0 warnings across all crates.
3. **Playwright Smoke Suite**:
   ```powershell
   cd "d:\Own Programs\InkWell\inkwell-m0"
   py -3 test_smoke.py
   ```
   *Outcome*: 18/18 checks pass.
