# Plan 027: Page Lifecycle Repair, Viewport Layout Synchronization & Customizable Page Insertion Dialog

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell-app/src/js/app.js inkwell-app/src/js/viewport.js inkwell-app/src/index.html inkwell-app/src/styles.css inkwell-app/src-tauri/src/commands.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / ux
- **Planned at**: commit `8337e2c`, 2026-08-17

## Why this matters

When users insert a blank page, `state.pageInfos` is updated in JavaScript, but `viewport.updateDocumentLayout(state.pageInfos)` is never invoked. As a result, the viewport's continuous layout engine remains bounded to the original page count. Navigating to the new page causes `getPageLayout()` to fallback to `y = 0` (top of page 0), and `getVisiblePages()` ignores the new page because its layout coordinates do not exist. Consequently, the newly added page cannot be viewed, scrolled to, or drawn on. Furthermore, the application lacks an interactive page insertion dialog, forcing users into a blind A4-portrait append at the end of the document rather than selecting custom positions, sizes, and paper templates.

## Current state

- `inkwell-app/src/js/app.js:2560-2591`: `insertBlankPage()` pushes a `PageInfo` object into `state.pageInfos`, but never calls `viewport.updateDocumentLayout(state.pageInfos)`.
- `inkwell-app/src/js/viewport.js:75-80`: `getPageLayout(sheetIndex)` returns fallback `{ sheet: sheetIndex, x: 0, y: 0, width: 595.0, height: 842.0 }` at `y = 0` when `sheetIndex` is not in `this.pageLayouts`.
- `inkwell-app/src/js/viewport.js:112-129`: `getVisiblePages(pane)` filters `this.pageLayouts`. Because `this.pageLayouts` lacks the new sheet, the new page is excluded from background and tile rendering.
- `inkwell-app/src/js/app.js:3576`: Clicking `btnHeaderAddPage` immediately calls `insertBlankPage()` without presenting options for position (Before/After current page, Start, End), paper format (A4, Letter, A3, Legal, Match Current), or paper orientation (Portrait, Landscape).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |

## Scope

**In scope** (the only files you should modify):
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`
- `inkwell-app/src-tauri/src/commands.rs`

**Out of scope** (do NOT touch):
- `inkwell/crates/inkwell-core/src/wal.rs`
- `inkwell/crates/inkwell-pdf/src/pdfium.rs`

## Git workflow

- Branch: `advisor/027-page-lifecycle-layout-sync`
- Commit message: `fix(page-lifecycle): synchronize viewport layouts and add page insertion dialog`

## Steps

### Step 1: Repair Viewport Layout Synchronization and Stroke Sheet Index Shifting in `app.js`

In `inkwell-app/src/js/app.js`, modify `insertBlankPage()`:
1. Accept an options object: `{ targetIndex, widthPt, heightPt, template, orientation }`.
2. Compute `targetIndex` based on user selection (default: after current sheet `state.leftSheet + 1`).
3. When `insert_blank_page` is invoked at `targetIndex < state.pageInfos.length`, shift in-memory stroke sheets for all strokes where `s.sheet >= targetIndex` (`s.sheet += 1`), and shift image sheets similarly (`img.sheet += 1`).
4. Insert `pageInfo` at `state.pageInfos.splice(targetIndex, 0, pageInfo)` (and sync with `state.tabs`).
5. Call `viewport.updateDocumentLayout(state.pageInfos)`.
6. Call `goToPage(targetIndex, 'left')`.
7. Refresh UI components: `updatePageUI()`, `updateDocInfo()`, `updateToolBadges()`, `renderThumbnails()`, `scheduleRedrawTiles()`, `redrawAll()`.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0, 18/18 checks pass

### Step 2: Build the Interactive Page Insertion Modal in `index.html` and `styles.css`

1. In `inkwell-app/src/index.html`, add a modal `#insertPageModal` containing:
   - **Insert Position**:
     - `after_current` (After current page - Page X)
     - `before_current` (Before current page)
     - `document_end` (At end of document)
     - `document_start` (At beginning of document)
   - **Paper Format / Size**:
     - `match_current` (Match current page dimensions)
     - `a4` (A4 — 595 × 842 pt / 210 × 297 mm)
     - `letter` (US Letter — 612 × 792 pt / 8.5 × 11 in)
     - `a3` (A3 — 842 × 1191 pt)
     - `legal` (US Legal — 612 × 1008 pt)
     - `custom` (Width & Height in points)
   - **Orientation**:
     - `portrait` (Vertical)
     - `landscape` (Horizontal)
   - **Paper Template**:
     - `blank` (Plain White Paper)
     - `ruled` (College Ruled Lines)
     - `grid` (Engineering 5mm Graph)
     - `dot` (Bullet Dot Grid)
     - `cornell` (Cornell Note-taking Layout)
     - `dark` (AMOLED Dark Slate Chalkboard)
   - Action buttons: `btnConfirmInsertPage` and `btnCancelInsertPage`.
2. In `inkwell-app/src/styles.css`, style the `#insertPageModal` with glassmorphic backdrop, accessible 44px buttons, high-contrast segmented switches, and focus rings.

**Verify**: `cd inkwell; cargo test` → exit 0

### Step 3: Wire Modal Triggers and Quick Insert Shortcuts in `app.js`

1. Update `btnHeaderAddPage`, `btnAddPage`, `btnDocInfoInsertPage`, `btnMoreAddPage`, and `btnInsertBlank` to open `#insertPageModal` with pre-filled defaults based on current page size.
2. Add Shift+Click shortcut on `btnHeaderAddPage` for instant quick-insert without modal using current page dimensions.
3. Handle Escape key and backdrop click to dismiss `#insertPageModal`.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0

## Test plan

- Test adding a page at end of a 1-page document and confirm page 2 renders white paper background at `y > 842` and accepts ink.
- Test inserting a page before page 1 in a multi-page document and confirm strokes on old page 1 now correctly display on page 2.
- Test custom dimensions (Letter landscape) and verify correct bounding box in viewport.

## Done criteria

- [ ] `viewport.updateDocumentLayout` is called on every page addition
- [ ] Added pages render paper background, tiles, and strokes without clipping or falling back to $(0,0)$
- [ ] Insert Page modal allows configuring position, paper size, orientation, and template
- [ ] In-between page insertion shifts stroke and image sheet indices correctly
- [ ] `cd inkwell-m0; py -3 test_smoke.py` exits 0 with 18/18 checks pass
- [ ] `cd inkwell; cargo test` exits 0

## STOP conditions

- If `insert_blank_page` in PDFium backend fails to insert at custom indices, stop and verify `commands.rs:743`.
- If viewport continuous scroll coordinate transformation causes jumping on page resize, stop and check `viewport.js:40-73`.

## Maintenance notes

- When deleting or reordering pages in Plan 030, ensure stroke sheet shifting logic reuses the helper function created here.
