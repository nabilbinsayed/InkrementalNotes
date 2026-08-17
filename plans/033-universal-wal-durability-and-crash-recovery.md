# Plan 033: Universal WAL Durability & Comprehensive Crash Recovery for All Mutations

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell/crates/inkwell-core/src/wal.rs inkwell-app/src-tauri/src/commands.rs inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Status**: DONE
- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/032-autosave-after-delay-and-dirty-tracking.md
- **Category**: bug / reliability
- **Planned at**: commit `8337e2c`, 2026-08-18

## Why this matters

The Write-Ahead Log (`inkwell-wal`) guarantees crash resilience by appending mutation records to a local journal in system temporary directories before the PDF is permanently rewritten. However, the current WAL implementation only records strokes (`Added`, `Removed`) and blank page insertion (`PageInserted`). If the application terminates abnormally, all inserted image annotations, text notes, page deletions, page reordering, and page rotations are completely lost. Extending `WalEntry` to comprehensively journal all mutation types and integrating recovery into document load ensures total data safety across any crash scenario.

## Current state

- `inkwell/crates/inkwell-core/src/wal.rs:31-43`: `WalEntry` only defines `Added`, `Removed`, and `PageInserted`.
- `inkwell-app/src-tauri/src/commands.rs:1008-1192`: `delete_page`, `duplicate_page`, `rotate_page`, and `reorder_page` mutate backend documents in memory without logging to WAL.
- `inkwell-app/src/js/app.js:1040-1070`: Image annotations and text objects exist solely in JS heap (`state.images`, `state.textObjects`) with no backend WAL logging.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |
| Playwright Smoke Tests | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| E2E Test Suite | `cd e2e-tests; py -3 run_all.py` | exit 0, 272/272 pass |

## Scope

**In scope** (the only files you should modify):
- `inkwell/crates/inkwell-core/src/wal.rs`
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/app.js`

**Out of scope** (do NOT touch):
- `inkwell/crates/inkwell-core/src/pdf.rs`
- `inkwell-m0/`

## Git workflow

- Branch: `advisor/033-universal-wal-recovery`
- Commit message: `feat(wal): expand WAL journal to cover images, text, and page mutations with full crash recovery`

## Steps

### Step 1: Expand `WalEntry` and Binary Record Serializer in `wal.rs`

1. In `inkwell/crates/inkwell-core/src/wal.rs`, add new entry kinds:
   ```rust
   const KIND_ADD_LEGACY: u8 = 1;
   const KIND_REMOVE: u8 = 2;
   const KIND_ADD: u8 = 3;
   const KIND_PAGE_INSERT: u8 = 4;
   const KIND_PAGE_DELETE: u8 = 5;
   const KIND_PAGE_REORDER: u8 = 6;
   const KIND_PAGE_ROTATE: u8 = 7;
   const KIND_IMAGE_ADD: u8 = 8;
   const KIND_IMAGE_REMOVE: u8 = 9;
   const KIND_TEXT_UPSERT: u8 = 10;
   const KIND_TEXT_REMOVE: u8 = 11;
   ```
2. Update `WalEntry` enum:
   ```rust
   #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
   pub enum WalEntry {
       Added { sheet: usize, stroke: Stroke },
       Removed(u128),
       PageInserted { index: usize, width_pt: f64, height_pt: f64 },
       PageDeleted { index: usize },
       PageReordered { from_index: usize, to_index: usize },
       PageRotated { index: usize, clockwise: bool },
       ImageAdded { sheet: usize, id: String, x: f64, y: f64, width: f64, height: f64, data_url: String },
       ImageRemoved { id: String },
       TextUpsert { sheet: usize, id: String, x: f64, y: f64, text: String, font_size: f64, color: String, bold: bool, italic: bool, width: f64, height: f64 },
       TextRemoved { id: String },
   }
   ```
3. Implement robust bincode / JSON payload serialization and deserialization in `append` and `replay` with FNV-1a checksum validation to prevent corruption on torn writes.

**Verify**: `cd inkwell; cargo test` -> exit 0.

### Step 2: Wire WAL Appends in Tauri Backend Commands (`commands.rs`)

1. Update `delete_page`, `duplicate_page`, `rotate_page`, `reorder_page` to dispatch corresponding `WalOp::Append(...)` via `state.wal`.
2. Add dedicated Tauri commands for journaling text and image mutations:
   - `journal_image_mutation(op: String, image: ImagePayload, state: State<'_, AppState>)`
   - `journal_text_mutation(op: String, text: TextPayload, state: State<'_, AppState>)`
3. In `open_pdf` / `open_pdf_bytes`, update `OpenPdfResult` to return recovered images, text annotations, and layout operations:
   ```rust
   #[derive(Debug, Serialize, Deserialize)]
   pub struct OpenPdfResult {
       pub page_infos: Vec<PageInfo>,
       pub recovered_strokes: usize,
       pub recovered_images: usize,
       pub recovered_texts: usize,
       pub loaded_strokes: Vec<FrontendStroke>,
       pub loaded_images: Vec<FrontendImage>,
       pub loaded_texts: Vec<FrontendText>,
       pub outline: Vec<inkwell_pdf::TocItem>,
   }
   ```

**Verify**: `cd inkwell-app/src-tauri; cargo clippy --all-targets` -> exit 0.

### Step 3: Integrate Full Recovery in Frontend `app.js`

1. In `handlePdfLoadSuccess(...)`, ingest `recovered_images`, `recovered_texts`, and display a rich recovery toast:
   ```javascript
   const totalRecovered = (r.recovered_strokes || 0) + (r.recovered_images || 0) + (r.recovered_texts || 0);
   if (totalRecovered > 0) {
     showToast(`Restored ${totalRecovered} unsaved edits from crash journal`, 'info');
   }
   ```
2. Whenever an image is pasted or text is typed/edited, send asynchronous journal notifications to the backend.

**Verify**: `cd e2e-tests; py -3 run_all.py` -> exit 0.

## Test plan

- Test that adding an image, adding a text note, deleting a page, and abruptly restarting reloads all modifications from WAL journal.
- Test that torn/corrupt WAL records at the end of the journal are dropped cleanly without failing intact earlier records.
- Test that saving PDF truncates WAL journal cleanly.

## Done criteria

- [ ] WAL journal encodes all mutation types (strokes, images, text, page lifecycle).
- [ ] Replay recovers complete document state accurately.
- [ ] No regression in inking performance or WAL sync latency.
- [ ] All tests pass.
