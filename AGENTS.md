# AGENTS.md — AI Agent Guidance for InkWell Repository

Read this before making changes to the InkWell codebase.

## Subsystem Directory Map

- `inkwell/`: Core Rust workspace (`inkwell-core`, `inkwell-pdf`, `inkwell-wal`)
  - `crates/inkwell-core/`: Document model, ink mathematics (One-Euro filter, RDP, ribbon outline generation), Write-Ahead Log engine (`wal.rs`), tile cache (`tiles.rs`).
  - `crates/inkwell-pdf/`: Low-level PDF parser (`pdf.rs`), object structure (`pdfobj.rs`), PDFium bindings and normalisation engine (`pdfium.rs`).
- `inkwell-app/`: Desktop application host (Tauri v2 + frontend UI)
  - `src-tauri/`: Tauri backend IPC commands (`commands.rs`), application state (`state.rs`), and entry point (`main.rs`).
  - `src/`: Web frontend UI (`index.html`, `styles.css`, `js/app.js`, `js/ink.js`, `js/viewport.js`, `js/hud.js`).
- `inkwell-m0/`: M0 latency spike prototype and Playwright smoke tests (`test_smoke.py`).
- `plans/`: Implementation plans and execution tracking (`README.md`).

## Non-Negotiable Rules

1. **Strict PDF Standards Compliance**: All output must be valid, standard PDF files. Ink layers are appended as vector filled ribbon outlines (`ribbon_outline`), never simple stroked lines or binary sidecar files.
2. **Append-Only Incremental Save**: Original PDF bytes must never be corrupted or overwritten in-place. `atomic_write` and append-only incremental PDF structures preserve base document integrity.
3. **No Underlay Rasterisation at Import**: PDFs are vector-rendered on demand per LOD tile. Never rasterise the base PDF into bitmaps on document load.
4. **WAL Journal Durability**: Write-Ahead Log (`inkwell-wal`) entries are fsynced immediately upon stroke commit. WAL journals reside in system temporary directories, staying out of cloud sync folders to prevent sync thrashing.
5. **No Synthetic Delay or Swallowed Errors**: Always trace error root causes. Do not wrap critical failures in empty try/catch blocks or return silent dummy fallbacks.
6. **Maintain Touch Target & Accessibility Guidelines**: Minimum interactive target dimensions must satisfy touch guidelines (44x44px), with clear focus indicators and glassmorphic toast notifications for user feedback.

## Verification Commands

| Scope / Target | Command | Expected Outcome |
|---|---|---|
| Playwright Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |
