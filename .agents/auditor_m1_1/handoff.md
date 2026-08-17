# Forensic Audit Report: Milestone 1 (Security Hardening & PDFium Worker Pipeline)

**Work Product**: Milestone 1 Implementation across `inkwell-app` and `inkwell` crates  
**Profile**: General Project / Development Mode  
**Auditor**: `auditor_m1_1`  
**Verdict**: **CLEAN**

---

## 1. Observation

A comprehensive line-by-line inspection of all Milestone 1 source changes was conducted:

1. **Safe Unicode Slicing in `search_pdf`** (`inkwell-app/src-tauri/src/commands.rs:805-831`):
   - Replaced raw byte slicing with character vector collection `text_chars = text.chars().collect::<Vec<char>>()`.
   - Performed lowercase matching over character sliding windows `text_lower_chars.windows(q_chars.len())`.
   - Clamped substring snippet indices with `char_idx.saturating_sub(40).min(text_chars.len())` and `(char_idx + q_chars.len() + 40).min(text_chars.len()).max(start)`.
   - Verified that multi-byte UTF-8 scripts (Bangla, CJK, Arabic, Math symbols, Emoji) produce safe character snippets without string index panics.

2. **DLL Hijacking Mitigation in `init_pdfium`** (`inkwell/crates/inkwell-pdf/src/lib.rs:18-60`):
   - Completely eliminated `std::env::current_dir()` search and relative path traversal (`./`, `../`).
   - Restricted DLL resolution strictly to the running executable's parent directory (`exe.parent()`), explicit operator environment variable `PDFIUM_DLL_DIR`, and system library bindings `Pdfium::bind_to_system_library()`.

3. **Varint Guards & Bounded Allocation in `codec.rs`** (`inkwell/crates/inkwell-core/src/codec.rs:92-105, 157, 181`):
   - In `get_uvarint`, added guards against 64-bit integer overflow: `if shift >= 64 || (shift == 63 && (b & 0x7F) > 1) { return Err(CodecError::Truncated); }`.
   - Bounded initial vector pre-allocations in `decode`: `Vec::with_capacity(count.min(1024))` and `Vec::with_capacity(n.min(1024))`.

4. **PDF Object Slicing & Token Clamping in `pdfobj.rs`** (`inkwell/crates/inkwell-core/src/pdfobj.rs:94-194`):
   - Clamped all return values in `skip_value` to `.min(d.len())` across dictionary, hex string, literal string, array, name, and indirect object reference parsers.
   - Guarded escape sequence parsing (`b'\\'`) with `if j < d.len()` before advancing pointer, preventing out-of-bounds reads on trailing backslashes.

5. **Path Traversal Sanitization & Parameter Validation** (`inkwell-app/src-tauri/src/commands.rs:563-577, 252-255, 723-725`):
   - In `save_pdf`, actively checks for `".."`, validates with `path.components().any(|c| c == std::path::Component::ParentDir)`, enforces `.pdf` extension (case-insensitive), and verifies that non-empty parent directories exist before writing.
   - In `create_blank_document` and `insert_blank_page`, validates that dimensions are finite and bounded between `72.0` and `14400.0` points.

6. **Tauri v2 Content Security Policy (CSP)** (`inkwell-app/src-tauri/tauri.conf.json:23-25`):
   - Hardened CSP configured: `"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'ipc:';"`.

7. **Non-Blocking PDFium Worker Pipeline & Bitmap Cache** (`inkwell-app/src-tauri/src/commands.rs:373-480`):
   - `render_tile` inspects `state.page_bitmap_cache` first to serve cached page bitmaps without redundant PDF byte re-parsing under the global PDFium mutex.
   - CPU-bound tile cropping, RGBA alpha swizzling, and byte validation are offloaded to `tauri::async_runtime::spawn_blocking`.

8. **Frontend Retry Loop Elimination** (`inkwell-app/src/js/app.js:241-248`):
   - In `fetchTile` catch handler, caches `tileCache.set(key, null)` and avoids invoking `scheduleRedrawTiles()`, preventing recursive re-request storms on render errors.

9. **Dedicated Unit Tests**:
   - `codec_rejects_overflowing_varint_and_bounds_allocation` (`inkwell-core/tests/integration.rs`)
   - `pdfobj_skip_value_bounds_checks_and_clamps` (`inkwell-core/tests/integration.rs`)
   - `test_unicode_search_window_slicing_safety` (`inkwell-pdf/tests/integration.rs`)

---

## 2. Logic Chain

1. **No Hardcoded Test Outputs**:
   - Audited all modified files and test assertions. All tests perform dynamic mathematical checks, malformed byte slice handling, Unicode sliding window substring matching, and real PDF generation. No static mock or hardcoded bypass string exists.
2. **No Facade Implementations**:
   - Every function (`search_pdf`, `init_pdfium`, `render_tile`, `save_pdf`, `get_uvarint`, `skip_value`) contains genuine computational logic, bounds checking, and error handling.
3. **No Fabricated Outputs / Swallowed Errors**:
   - Error channels across async commands propagate structured error messages via `Result<T, String>` and `Result<T, CodecError>`.
4. **Behavioral Integrity**:
   - `cargo test -- --test-threads=1` passed 51/51 tests across all crates.
   - `cargo clippy --all-targets` compiled cleanly with 0 warnings across both the core workspace and Tauri host backend.
   - Playwright smoke test (`inkwell-m0/test_smoke.py`) passed all 18/18 checks.

---

## 3. Caveats

- For local PDF tile rendering in development or test environments, `pdfium.dll` must reside in the executable's directory, the system library path, or the path specified by `PDFIUM_DLL_DIR`. If absent, PDFium methods return explicit, graceful error messages.

---

## 4. Conclusion

**Verdict: CLEAN**

The Milestone 1 work product meets all acceptance criteria, security requirements, and integrity standards. No integrity violations, shortcuts, facade implementations, or hardcoded mocks were detected.

---

## 5. Verification Method

To independently reproduce the audit results:

```powershell
# 1. Execute full Rust workspace test suite
cd "d:\Own Programs\InkWell\inkwell"
cargo test -- --test-threads=1
# Expected output: 51 passed; 0 failed

# 2. Check Rust Clippy across core and Tauri host
cd "d:\Own Programs\InkWell\inkwell"
cargo clippy --all-targets
# Expected output: zero warnings

cd "d:\Own Programs\InkWell\inkwell-app\src-tauri"
cargo clippy --all-targets
# Expected output: zero warnings

# 3. Execute Playwright smoke tests
cd "d:\Own Programs\InkWell\inkwell-m0"
py -3 test_smoke.py
# Expected output: 18/18 checks passed
```
