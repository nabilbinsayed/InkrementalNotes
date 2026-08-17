# Plan 030: Page Management Suite & Paper Background Templates

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell-app/src/js/app.js inkwell-app/src/index.html inkwell-app/src/styles.css inkwell/crates/inkwell-core/src/doc.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/027-page-lifecycle-layout-sync-and-insertion-dialog.md
- **Category**: ux
- **Planned at**: commit `8337e2c`, 2026-08-17

## Why this matters

A complete PDF and inking workflow requires flexible page management: deleting unwanted pages, duplicating pages with or without ink, rotating mis-oriented scans (90° CW/CCW), reordering pages via thumbnail drag-and-drop, and providing note-taking paper background templates (College Ruled lines, 5mm Engineering Grid, Bullet Dot Grid, Cornell Study format, and Dark AMOLED Chalkboard). Currently, users cannot delete or reorganize pages, and blank notes are restricted to unruled white sheets.

## Current state

- `inkwell-app/src/js/app.js:255-279`: `drawPageBackground(pl)` draws a plain white rectangle with a basic drop shadow, offering no template guidelines.
- `inkwell-app/src-tauri/src/commands.rs:717-767`: Backend only provides `insert_blank_page`. There is no `delete_page`, `duplicate_page`, `rotate_page`, or `reorder_pages` command.
- `inkwell-app/src/js/app.js:3363-3370`: Thumbnail cards have no action menu ("...") for quick per-page operations.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |

## Scope

**In scope** (the only files you should modify):
- `inkwell/crates/inkwell-core/src/doc.rs`
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`

**Out of scope** (do NOT touch):
- `inkwell/crates/inkwell-core/src/wal.rs`
- `inkwell/crates/inkwell-pdf/src/pdfobj.rs`

## Git workflow

- Branch: `advisor/030-page-management-templates`
- Commit message: `feat(pages): add page management actions and rich paper template backgrounds`

## Steps

### Step 1: Implement Core Sheet Deletion and Reordering in `doc.rs`

In `inkwell/crates/inkwell-core/src/doc.rs`:
1. Add `remove_sheet(index: usize) -> Option<Sheet>` to `Document`.
2. Add `reorder_sheet(from_index: usize, to_index: usize)` to `Document`.
3. Add unit tests for sheet deletion, duplicate cloning, and reordering.

**Verify**: `cd inkwell; cargo test` → exit 0, all tests pass

### Step 2: Implement Page Operation IPC Commands in `commands.rs`

In `inkwell-app/src-tauri/src/commands.rs`:
1. Add `delete_page(index: usize, state: State<'_, AppState>) -> Result<bool, String>`:
   - Removes page from PDFium bytes and `doc.remove_sheet(index)`.
   - Records WAL entry and clears bitmap cache.
2. Add `duplicate_page(index: usize, with_ink: bool, state: State<'_, AppState>) -> Result<PageInfo, String>`:
   - Duplicates page in PDFium at `index + 1`.
   - Clones strokes if `with_ink` is true.
3. Add `rotate_page(index: usize, degrees: i32, state: State<'_, AppState>) -> Result<bool, String>`:
   - Rotates page by 90/180/270 degrees in PDFium and clears bitmap cache.

**Verify**: `cd inkwell; cargo test` → exit 0

### Step 3: Implement Paper Background Patterns Renderer in `app.js`

In `inkwell-app/src/js/app.js`:
1. In `drawPageBackground(pl, pane)`:
   - Check page template type (stored in `pi.template` or document default).
   - If `template === 'ruled'`: render horizontal guideline rules every 28pt in `#d0d7de` with a left margin line at 72pt in `#fca5a5`.
   - If `template === 'grid'`: render a 5mm (14.17pt) or 20pt square graph grid.
   - If `template === 'dot'`: render a 5mm dot grid with subtle circular dots (`#94a3b8`).
   - If `template === 'cornell'`: render standard Cornell study layout (header title bar, 2.5in cue column, summary footer).
   - If `template === 'dark'`: fill with `#1e293b` (slate chalkboard) with `#334155` subtle grid lines.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0

### Step 4: Add Thumbnail Card Context Menus and Action Buttons in `index.html` and `app.js`

1. In `inkwell-app/src/index.html` and `app.js`:
   - Add a "..." hover action button on every `.thumb-card`.
   - Clicking opens a context menu with:
     - `Insert Page After`
     - `Duplicate Page` (with Ink / Blank)
     - `Rotate 90° Clockwise`
     - `Rotate 90° Counter-Clockwise`
     - `Clear Ink on Page`
     - `Delete Page` (with confirmation if document has >1 page).
2. Wire each menu action to the corresponding IPC command and refresh layout with `viewport.updateDocumentLayout(state.pageInfos)`.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0, 18/18 checks pass

## Test plan

- Test deleting page 2 in a 3-page document; verify page count becomes 2 and page 3 becomes page 2.
- Test duplicating page 1 with ink; verify identical copy is inserted at page 2 with matching strokes.
- Test selecting College Ruled template on a blank whiteboard note; verify crisp lines render under the ink.

## Done criteria

- [ ] Delete Page removes page from PDF, doc model, and updates viewport layout
- [ ] Duplicate Page copies page geometry and strokes cleanly
- [ ] Rotate Page rotates PDFium page and resets cached raster tiles
- [ ] Paper templates (Ruled, Grid, Dot, Cornell, Dark) render smoothly beneath ink
- [ ] All Rust tests and Playwright smoke tests pass

## STOP conditions

- If deleting the sole remaining page in a document is attempted, prevent deletion and show warning toast.
- If page rotation changes width/height aspect ratio, ensure `pl.width` and `pl.height` update in `viewport.pageLayouts`.

## Maintenance notes

- Future vector export (`save_pdf`) can optionally burn the background paper guidelines into the exported PDF vector stream.
