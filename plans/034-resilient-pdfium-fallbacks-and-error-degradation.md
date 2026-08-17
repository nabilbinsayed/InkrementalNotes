# Plan 034: Resilient PDFium Fallbacks, Corrupt Document Recovery & Graceful Degradation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell-app/src-tauri/src/main.rs inkwell-pdf/src/lib.rs inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: stability / fallbacks
- **Planned at**: commit `8337e2c`, 2026-08-18

## Why this matters

If the native PDFium dynamic library (`pdfium.dll`, `libpdfium.so`, or `libpdfium.dylib`) is missing, inaccessible, or corrupted, or if a user attempts to open a malformed or password-protected PDF, the application must not crash or leave the user with an unrecoverable blank canvas. Currently, if PDFium fails to load or render a tile, the frontend displays generic errors, and operations like page insertion or search fail with backend panics or unhandled error strings. Hardening fallback chains with vector placeholders, clear diagnostic recovery dialogs, and shallow PDF parsers ensures robust operation under adverse host environments.

## Current state

- `inkwell-app/src-tauri/src/commands.rs:119-157`: Shallow `PdfFile` parser fallback only works on classic xref tables; object stream PDFs fail silently if PDFium is missing.
- `inkwell-app/src-tauri/src/commands.rs:386-390`: `render_tile` returns an error string when PDFium is missing, which causes broken tiles on the frontend.
- `inkwell-app/src/js/app.js:262-268`: `fetchTile` catches errors and sets `tileRenderError`, but does not render clean fallback canvas grids.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |
| Playwright Smoke Tests | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/styles.css`

**Out of scope**:
- `inkwell/crates/inkwell-core/src/wal.rs`

## Git workflow

- Branch: `advisor/034-resilient-pdfium-fallbacks`
- Commit message: `fix(fallback): enhance PDFium missing DLL recovery, corrupt PDF degradation, and diagnostic banners`

## Steps

### Step 1: Implement Graceful Blank / Grid Canvas Fallback in `render_tile`

1. In `commands.rs`, if PDFium is unavailable or fails on a specific page:
   - Rather than returning a fatal IPC error that breaks all tile renderers, return a structured fallback notification or an empty white/translucent tile buffer with a diagnostic watermark pattern.
   - Return clear metadata indicating degraded mode.

**Verify**: `cd inkwell; cargo test` -> exit 0.

### Step 2: Add Diagnostic Recovery Banner and Fallback Tile Painter in `app.js`

1. In `app.js`, when PDFium is unavailable:
   - Display a non-intrusive glassmorphic banner in the viewport: *"PDFium native engine unavailable. Inking and whiteboard features remain fully functional."*
   - Paint clean vector page backgrounds and note template grids so the user can continue taking notes, drawing, and exporting.
2. Provide a "Locate PDFium DLL" or "Retry Engine" action button in the banner that re-attempts dynamic library discovery without restarting the app.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` -> exit 0.

## Test plan

- Test app startup with missing `pdfium.dll`: verify no panic, clean fallback UI, and drawing/saving functions properly.
- Test opening a corrupted PDF file: verify graceful error toast and option to start blank whiteboard.

## Done criteria

- [ ] Missing PDFium produces no crashes or unhandled error loops.
- [ ] Fallback paper canvas is rendered seamlessly for inking.
- [ ] Diagnostic banner guides user on DLL installation without obstructing notes.
- [ ] Tests and lints pass with zero warnings.
