# Milestone 1: Security Hardening & PDFium Worker Pipeline Handoff Report

## 1. Observation
- **Item A (PDF Search Unicode Slicing)**: In `inkwell-app/src-tauri/src/commands.rs:770-825`, raw byte slicing on multi-byte UTF-8 strings was replaced by character array conversion `text.chars().collect::<Vec<char>>()`, lowercasing matching via character windows `text_lower_chars.windows(q_chars.len())`, and character-boundary clamped slicing `start = char_idx.saturating_sub(40).min(text_chars.len())` / `end = (char_idx + q_chars.len() + 40).min(text_chars.len()).max(start)`.
- **Item B (PDFium DLL Search Path Restriction)**: In `inkwell/crates/inkwell-pdf/src/lib.rs:18-60`, `std::env::current_dir()` search and relative `./`, `../` paths were completely eliminated. Lookup is strictly constrained to the directory of `current_exe()?.parent()`, `std::env::var("PDFIUM_DLL_DIR")`, and system library bindings `Pdfium::bind_to_system_library()`.
- **Item C (Bounds Checking & Varint Guards)**:
  - In `inkwell/crates/inkwell-core/src/codec.rs:89-105, 157, 182`: `get_uvarint` returns `Err(CodecError::Truncated)` if `shift >= 64 || (shift == 63 && (b & 0x7F) > 1)`. Initial buffer allocations in `decode` are bounded: `Vec::with_capacity((count as usize).min(1024))` and `Vec::with_capacity((n as usize).min(1024))`.
  - In `inkwell/crates/inkwell-core/src/pdfobj.rs:94-194`: `skip_value` end offsets are clamped to `d.len()` across dict, hex string, literal string, array, name, and indirect reference patterns. In string parsing, `b'\\'` bounds check `if j < d.len()` before advancing.
- **Item D (Path Sanitization & Parameter Bounds)**: In `inkwell-app/src-tauri/src/commands.rs:563-577, 252-255, 716-719`: `save_pdf` asserts no `..` traversal components, verifies destination ends with `.pdf` (case-insensitive), and verifies parent directory exists. `create_blank_document` and `insert_blank_page` validate dimensions are finite numbers between `72.0` and `14400.0` pt.
- **Item E (Tauri v2 CSP Hardening)**: In `inkwell-app/src-tauri/tauri.conf.json:23-25`: `"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'ipc:';"`.
- **Item F & G (Non-blocking Tile Rendering & Memory-budgeted Bitmap Cache)**: In `inkwell-app/src-tauri/src/commands.rs:370-480`: `render_tile` inspects `state.page_bitmap_cache` first to serve cached page bitmaps without PDFium parsing, releases mutex guards promptly, and offloads pixel cropping/BGRA-to-RGBA swizzling/alpha blending to `tauri::async_runtime::spawn_blocking`.
- **Item H (Tile Request Error Handling)**: In `inkwell-app/src/js/app.js:241-248`: `fetchTile` catch handler caches `tileCache.set(key, null)` and avoids invoking `scheduleRedrawTiles()` to prevent recursive retry loop storms.
- **Unit Tests Added**:
  - `codec_rejects_overflowing_varint_and_bounds_allocation` in `inkwell-core/tests/integration.rs`
  - `pdfobj_skip_value_bounds_checks_and_clamps` in `inkwell-core/tests/integration.rs`
  - `test_unicode_search_window_slicing_safety` in `inkwell-pdf/tests/integration.rs`
- **Plan Status**: `plans/README.md` updated with Plan 021 and Plan 023 marked as `DONE`.

## 2. Logic Chain
1. *Unicode Slicing*: In Rust, slicing `&str` on byte indices that do not land on valid UTF-8 code point boundaries panics immediately. Converting text and query strings to `Vec<char>` and searching on char-level windows guarantees that slice indices are indices into the character array, making search operations across non-ASCII scripts (Bangla, Arabic, CJK, emojis, math notation) mathematically incapable of panicking.
2. *DLL Hijacking Prevention*: Loading dynamic libraries from `current_dir()` allows malicious files in untrusted download directories to execute arbitrary code. Constraining search to executable parent directory, explicit environment variable, and system library bindings prevents search-order hijacking.
3. *Varint & Binary Bounds*: Varints shift left by 7 bits per iteration; without `shift >= 64` checks, 64-bit integer overflow can occur. Unchecked `Vec::with_capacity(count)` on untrusted binary payloads can trigger OOM panics. Bounding initial allocations to `.min(1024)` allows subsequent dynamic growth without allocating gigabytes upfront on malformed payloads.
4. *Path Sanitization*: Validating path components against `ParentDir`, enforcing `.pdf` extensions, and checking parent folder existence prevents arbitrary path write traversal.
5. *Threadpool Offloading & LRU Caching*: Offloading tile rasterization and RGBA blending to `spawn_blocking` keeps Tokio worker threads unblocked. Checking `page_bitmap_cache` prior to calling `load_pdf_from_byte_slice` avoids repeated multi-megabyte PDF parsing per tile.

## 3. Caveats
- `pdfium.dll` must exist in the application binary folder, in `PDFIUM_DLL_DIR`, or on system library search path for PDF rendering to function.
- If `CARGO_INCREMENTAL=1` triggers compiler stack issues on Windows GNU toolchains, `CARGO_INCREMENTAL=0` ensures clean compilation.

## 4. Conclusion
All requirements for Milestone 1 across Items A through H and Plans 021 and 023 are fully implemented, hardened, and verified with all tests passing cleanly.

## 5. Verification Method
- **Rust Core Tests**: `cd inkwell; cargo test -- --test-threads=1` -> 51 passed (0 failed).
- **Rust Clippy**: `cd inkwell; cargo clippy --all-targets` and `cd inkwell-app/src-tauri; cargo clippy --all-targets` -> exit 0, zero warnings.
- **Playwright Smoke Test**: `cd inkwell-m0; py -3 test_smoke.py` -> exit 0, 18/18 checks passed.
