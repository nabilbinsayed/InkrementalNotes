# Plan 037: High-Precision Character-Level Text Selection Engine & Complete Overhaul

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aef1b6a..HEAD -- inkwell/crates/inkwell-pdf/src/text.rs inkwell-app/src/js/workspace/text-selection.js inkwell-app/src/js/render/overlays.js inkwell-app/src/js/main.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

The PDF text selection engine is currently marked UNFIXED because drag-selecting text across multiple lines produces discontinuous character index spans, miscalculated line bounds, and erratic visual highlights. Additionally, canvas coordinate transforms with varying Device Pixel Ratios (DPR) cause selection highlight rectangles to drift from under the actual rendered text glyphs. Fixing this provides pixel-accurate letter-by-letter snapping, double-click word expansion, triple-click line selection, and seamless clipboard copying across arbitrary PDF font layouts.

## Current state

- `inkwell/crates/inkwell-pdf/src/text.rs`:
  Extracts glyphs and lines from PDFium. Lines are segmented, but characters without tight bounding boxes or with non-standard font transforms can have zero-width bounds or irregular y-coordinates:
  ```rust
  // crates/inkwell-pdf/src/text.rs:148-150
  let y0 = page_h - top.max(bottom);
  let y1 = page_h - top.min(bottom);
  let has_bounds = (x1 - x0).abs() > 0.001 && (y1 - y0).abs() > 0.001;
  ```
- `inkwell-app/src/js/workspace/text-selection.js`:
  Computes continuous character spans and handles word/line expansions. Needs robust asynchronous page text caching (`ensurePageTextData`, `preloadNearbyPageText`) and non-linear multi-line bounding box aggregation.
- `inkwell-app/src/js/render/overlays.js`:
  Draws selection highlight rectangles over the canvas. Context transform must be reset before scaling by DPR so highlights align perfectly with PDFium rendered tiles.
- `inkwell-app/src/js/main.js`:
  Currently lacks pointer event hooks for the `textSelect` tool in `attachPointerHandlers`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Core Clippy | `cd inkwell; cargo clippy --all-targets` | exit 0, zero warnings |
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| JS Syntax | `node -c inkwell-app/src/js/workspace/text-selection.js` | exit 0, no errors |

## Scope

**In scope**:
- `inkwell/crates/inkwell-pdf/src/text.rs`
- `inkwell/crates/inkwell-pdf/tests/integration.rs`
- `inkwell-app/src/js/workspace/text-selection.js`
- `inkwell-app/src/js/render/overlays.js`
- `inkwell-app/src/js/main.js`

**Out of scope**:
- OCR of scanned bitmap pages (only vector PDFium text layers).
- Modifying underlying PDF text stream content (read-only selection).

## Git workflow

- Branch: `advisor/037-text-selection-accuracy`
- Commit style: `feat(text-selection): <description>`

## Steps

### Step 1: Normalize Character Bounding Boxes and Line Sorting in Rust
In `inkwell/crates/inkwell-pdf/src/text.rs`:
1. Ensure all `CharSpan` bounding boxes have strictly non-negative dimensions and fall back gracefully to segment bounds if character tight bounds are empty.
2. Group characters into lines using baseline tolerance (`vert_diff < line_h * 0.5`) and sort characters within each line strictly left-to-right (`x0`).
3. Return pre-calculated line bounding rectangles that span from `first_char.x0` to `last_char.x1` with line baseline height.

**Verify**: `cd inkwell; cargo test --test integration` → exit 0

### Step 2: Implement Robust Continuous Range Math in `text-selection.js`
In `inkwell-app/src/js/workspace/text-selection.js`:
1. Add `ensurePageTextData(sheet)` with inflight promise deduplication to prevent duplicate IPC calls.
2. Add `preloadNearbyPageText(centerSheet, viewport)` to fetch text for visible and adjacent pages ahead of time.
3. Update `computeTextSelectionRanges(sheet, startCharIdx, endCharIdx)`:
   - Order indices `minIdx = min(start, end)` and `maxIdx = max(start, end)`.
   - Slice characters from `minIdx` to `maxIdx`.
   - Group characters by `line_index` and calculate contiguous highlight boxes per line chunk.
   - Return `{ sheet, startCharIdx, endCharIdx, text, rects, chars }`.
4. Implement `expandSelectionToWord(sheet, charIndex)` and `expandSelectionToLine(sheet, charIndex)`.

**Verify**: `node -c inkwell-app/src/js/workspace/text-selection.js` → exit 0

### Step 3: Align Overlay Drawing Transforms in `overlays.js`
In `inkwell-app/src/js/render/overlays.js` (and compositor overlays):
1. In `drawPersistentTextSelectionHighlights(ctx, viewport)`:
   - Apply `ctx.save()`, `ctx.setTransform(1, 0, 0, 1, 0, 0)`, `ctx.scale(state.dpr, state.dpr)`.
   - Convert page-space highlight rects `[x0, y0, x1, y1]` into viewport screen coordinates via `viewport.pageToScreen(sheet, x, y, pane)`.
   - Fill highlight rects with `rgba(45, 108, 223, 0.28)` and stroke selection drag handles.
   - Restore context cleanly.

**Verify**: `node -c inkwell-app/src/js/render/overlays.js` → exit 0

### Step 4: Wire Text Selection Tool Handlers in `main.js`
In `inkwell-app/src/js/main.js`:
1. In `attachPointerHandlers`:
   - On `pointerdown`: when `state.activeTool === 'textSelect'`, handle click count (1 = start range drag, 2 = word expand, 3 = line expand).
   - On `pointermove`: when `state.isSelectingText`, hit-test character at current pointer coordinates and update `state.textSelection`.
   - On `pointerup`: finalize selection and display copy/highlight popover if selected text is non-empty.

**Verify**: `node -c inkwell-app/src/js/main.js` → exit 0

## Test plan

- In `inkwell/crates/inkwell-pdf/tests/integration.rs`, add a test `test_extract_page_text_data_ordering` that verifies character indices are monotonic within lines and line grouping correctly identifies separate paragraphs.
- Verify Playwright smoke test passes: `cd inkwell-m0; py -3 test_smoke.py`.

## Done criteria

- [ ] `cd inkwell; cargo test` exits 0.
- [ ] `cd inkwell; cargo clippy --all-targets` exits 0 with zero warnings.
- [ ] Character selection accurately highlights single letters, words, and multi-line paragraphs without visual drift.
- [ ] Double-click selects word, triple-click selects entire line.
- [ ] `plans/README.md` status row updated to DONE.

## STOP conditions

- If PDFium returns invalid UTF-8 strings or negative character indices, stop and verify `text.unicode_string()` sanitization.
- If canvas transform matrices conflict with dual-pane split view coordinates, stop and verify `viewport.pageToScreen` implementation.

## Maintenance notes

- `PageTextData` is cached in memory per document session. When pages are deleted or reordered, ensure `state.pageTextData` keys are invalidated.
