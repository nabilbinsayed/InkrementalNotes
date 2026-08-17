## 2026-08-14T13:17:23Z
You are worker_m1_1, executing Milestone 1: Security Hardening & PDFium Worker Pipeline for InkWell.
Working directory: d:\Own Programs\InkWell\.agents\worker_m1_1\

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A forensic auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Context & Instructions:
1. Read:
   - `d:\Own Programs\InkWell\ORIGINAL_REQUEST.md`
   - `d:\Own Programs\InkWell\AGENTS.md`
   - `d:\Own Programs\InkWell\plans\021-pdfium-document-handle-and-threadpool-offload.md`
   - `d:\Own Programs\InkWell\plans\023-security-hardening-utf8-dll-csp-and-path-validation.md`
   - `d:\Own Programs\InkWell\.agents\sub_orch_m1_gen2\SCOPE.md`

2. Implement all required changes across the following items:
   Item A: Safe Unicode character-window slicing in PDF search (`search_pdf` in `inkwell-app/src-tauri/src/commands.rs`):
     - Replace raw byte slicing on text with character boundary-safe indexing (e.g. `chars()`, `char_indices()`) so non-ASCII and Unicode queries (Bangla text, emojis, math symbols) never panic.
   Item B: Restrict PDFium DLL search path in `inkwell/crates/inkwell-pdf/src/lib.rs`:
     - In `init_pdfium()`, eliminate `std::env::current_dir()` and relative `./` paths.
     - Restrict search strictly to: `std::env::current_exe()?.parent()`, `std::env::var("PDFIUM_DLL_DIR")`, and system library bindings (`Pdfium::bind_to_system_library()`).
   Item C: Bounds checking & varint guards:
     - In `inkwell/crates/inkwell-core/src/codec.rs`: bound initial `Vec::with_capacity((count as usize).min(1024))`. In `get_uvarint`, return `None` if `shift >= 64` or `shift == 63 && (b & 0x7F) > 1`.
     - In `inkwell/crates/inkwell-core/src/pdfobj.rs`: in `skip_value`, ensure returned end offsets are clamped to `d.len()`. Check `j < d.len()` before evaluating escape characters in dictionary parsing.
   Item D: Path sanitization & parameter bounds in `inkwell-app/src-tauri/src/commands.rs`:
     - In `save_pdf`, validate destination path does not contain relative path traversal (`..`), ends with `.pdf` (case-insensitive), and has a valid parent directory.
     - In `insert_blank_page` and `create_blank_document`, assert width and height are finite and bounded between `72.0` and `14400.0`.
   Item E: Tauri v2 CSP in `inkwell-app/src-tauri/tauri.conf.json`:
     - Set `"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'ipc:';"`
   Item F: Non-blocking PDFium tile rendering in `inkwell-app/src-tauri/src/commands.rs`:
     - Wrap CPU-heavy `render_tile` operations in `tauri::async_runtime::spawn_blocking(move || { ... }).await.map_err(...)`.
     - Ensure PDFium mutex lock is granular and serialized.
   Item G: Memory-budgeted bitmap cache in `inkwell-app/src-tauri/src/commands.rs`:
     - In `render_tile`, check `state.page_bitmap_cache.lock().unwrap().get(page, target_w, target_h)` before calling `load_pdf_from_byte_slice`.
   Item H: Single-retry tile request error handling in `inkwell-app/src/js/app.js`:
     - In `fetchTile`, remove `scheduleRedrawTiles()` from the `catch` block to prevent recursive loop storms. Mark tile error state safely.

3. Verification:
   - Run `cd inkwell; cargo test -- --test-threads=1` -> ensure all tests pass. Add unit tests for unicode search slicing if appropriate.
   - Run `cd inkwell-app/src-tauri; cargo clippy --all-targets` -> zero warnings.
   - Run `cd inkwell-m0; py -3 test_smoke.py` -> 18/18 checks pass.

4. Deliverables:
   - Write a detailed `handoff.md` in `d:\Own Programs\InkWell\.agents\worker_m1_1\handoff.md` following the Handoff Protocol (Observation, Logic Chain, Caveats, Conclusion, Verification Results).
   - Update `plans/README.md` rows for Plan 021 and Plan 023 if completed.
   - Send a completion message to the parent sub-orchestrator.
