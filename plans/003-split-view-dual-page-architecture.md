# Plan 003: Dual-Pane Split View Architecture & Navigation

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 80d21c6..HEAD -- inkwell-app/src/js/app.js inkwell-app/src/js/viewport.js`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/002-pdfium-tile-rasterizer-aspect-crop.md
- **Category**: bug
- **Planned at**: commit `80d21c6`, 2026-08-08

## Why this matters

The dual-pane Split View mode currently fails to work properly due to three architectural flaws:
1. **Single Sheet Coupling**: Both the left pane and right pane share a single global `state.currentSheet`. When Split View is toggled, both panes show the exact same page index.
2. **Drawing Pane Hardcoded Reset**: In `app.js` line 708 (`onUp`), `state.drawingPane` is hardcoded to `'left'` after every stroke completion, causing subsequent stylus pointer input, shape overlays, ruler lines, and laser pointer interactions on the right pane to be incorrectly attributed or rendered to the left pane.
3. **No Independent Navigation**: Page navigation controls (`btnPrev`, `btnNext`) only mutate `state.currentSheet`, making it impossible to read page N in the left pane while viewing page N+1 in the right pane.

## Current state

Files involved:
- `inkwell-app/src/js/app.js` — State object (lines 7–33), `redrawTiles` & `redrawTilesForPane` (lines 141–190), `redrawAll` (lines 218–231), `onUp` line 708 (`state.drawingPane = 'left'`), `toggleSplitView` (lines 806–813).
- `inkwell-app/src/js/viewport.js` — Viewport state management (lines 5–29).

Code excerpt (`app.js:708`):
```javascript
  drawCommittedStroke(strokeRec);
  state.cur = null;
  state.drawingPane = 'left'; // <-- HARDCODED RESET BUG
  clearWet();
```

Code excerpt (`app.js:148-153`):
```javascript
  if (!state.pageInfos.length) return;
  const pi = state.pageInfos[state.currentSheet]; // <-- HARDCODED SINGLE SHEET
  if (!pi) return;
  await Promise.all(visiblePanes().map(pane => redrawTilesForPane(pane, pi, drawEpoch)));
```

## Scope

**In scope**:
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/styles.css`
- `inkwell-app/src/index.html`

**Out of scope**:
- Tauri Rust backend commands (already sheet-indexed: `render_tile`, `commit_stroke`, `erase_strokes_near`).

## Git workflow

- Commit per step; message format: `fix(split-view): support independent dual-pane page navigation and drawing`

## Steps

### Step 1: Add independent sheet state for left and right panes in `app.js`

In `inkwell-app/src/js/app.js`:
1. Expand state model to track pane-specific active sheets:
```javascript
const state = {
  ...
  leftSheet: 0,
  rightSheet: 0, // Defaults to page 1 if available when split view opens
  activePane: 'left',
  ...
};
```
2. Update `currentSheet` getter/setter helpers or replace references with `paneSheet(pane)`:
```javascript
function paneSheet(pane) {
  if (pane === 'right' && viewport.splitMode) return state.rightSheet;
  return state.leftSheet;
}
```

### Step 2: Remove hardcoded `state.drawingPane = 'left'` in `onUp`

In `inkwell-app/src/js/app.js`:
In `onUp` (around line 708), remove `state.drawingPane = 'left';`. Keep `state.drawingPane` set to whichever pane initiated the gesture until the next `onDown` event selects the appropriate pane via `paneForEvent(e)`.

### Step 3: Update `redrawTiles` and `redrawAll` to render pane-specific sheets

In `inkwell-app/src/js/app.js`:
1. In `redrawTiles`:
```javascript
  for (const pane of visiblePanes()) {
    const sheetIdx = paneSheet(pane);
    const pi = state.pageInfos[sheetIdx];
    if (pi) {
      drawPageBackground(pane, pi);
      await redrawTilesForPane(pane, pi, sheetIdx, drawEpoch);
    }
  }
```
2. In `redrawAll`:
```javascript
  for (const pane of visiblePanes()) {
    const sheetIdx = paneSheet(pane);
    dctx.save();
    clipToPane(dctx, pane);
    paneTransform(dctx, pane);
    for (const s of state.strokes) {
      if (!s.deleted && s.sheet === sheetIdx) Ink.drawStroke(dctx, s);
    }
    dctx.restore();
  }
```

### Step 4: Add pane selection and independent page navigation UI controls

In `inkwell-app/src/index.html` and `inkwell-app/src/js/app.js`:
1. In `toggleSplitView()`, if `viewport.splitMode` is true and `state.rightSheet === state.leftSheet`, automatically set `state.rightSheet = Math.min(state.leftSheet + 1, state.pageInfos.length - 1)`.
2. Update page navigation controls so `btnPrev` / `btnNext` apply to `paneSheet(state.activePane)` (the active focused pane).
3. Add active pane visual focus indicator border in CSS (`.active-pane`).

## Test plan

- Test toggling split view mode.
- Verify left pane displays page 0 and right pane displays page 1.
- Verify strokes drawn on the right pane persist on sheet 1 without bleeding to sheet 0.
- Verify pan and zoom in the right pane operate smoothly.

## Done criteria

- [ ] Left and right panes display independent pages in Split View mode.
- [ ] Pointer drawing on right pane correctly targets right pane's sheet and transform.
- [ ] No hardcoded `drawingPane = 'left'` resets remain.
- [ ] `plans/README.md` updated.

## STOP conditions

- Stop if `viewport.screenToWorld` transforms misalign between panes.
