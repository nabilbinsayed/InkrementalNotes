# Plan 014: Stroke Canvas RAF Debouncing, Layout Cache, & Eraser Bug Fix

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat db1c3a4..HEAD -- inkwell-app/src/js/app.js inkwell-app/src/js/viewport.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/013-pdfium-document-cache-and-zero-copy-rgba.md
- **Category**: bug
- **Planned at**: commit `db1c3a4`, 2026-08-09

## Why this matters

Stroke erasing currently crashes with `ReferenceError: sheetIdx is not defined` because `eraseStrokesAt()` passes undefined variables `sheetIdx`, `x`, `y` to `invoke('erase_strokes_near')`. Additionally, `getBoundingClientRect()` layout thrashing in high-frequency pointer event handlers and un-debounced `redrawAll()` calls during pan/zoom cause dropped frames and digitizer latency.

By wrapping `redrawAll()` in a `requestAnimationFrame` debouncer, caching stage bounding rects on window resize/scroll, fixing the eraser variable references, and fixing the Ruler Shift-key snapping math typo, we restore core drawing correctness and ensure smooth 60fps canvas interaction.

## Current state

- `inkwell-app/src/js/app.js:501-505`: `eraseStrokesAt()` references undefined `sheetIdx`, `x`, `y`:
  ```javascript
  invoke('erase_strokes_near', {
    sheet: sheetIdx,
    px: x,
    py: y,
    radius: radius,
  });
  ```
- `inkwell-app/src/js/app.js:757`: Ruler Shift-key Y position uses `shapeStart[0]` (X) instead of `shapeStart[1]` (Y):
  ```javascript
  ey = state.shapeStart[0] + Math.sin(angle) * len;
  ```
- `inkwell-app/src/js/app.js:409`: `localXY()` calls `getBoundingClientRect()` on every pointer move event.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Python validator | `py -3 tools/validate.py` | exit 0, 24/24 pass |
| Playwright smoke test | `cd inkwell-m0 && py -3 test_smoke.py` | exit 0, 18/18 pass |

## Scope

**In scope**:
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/js/viewport.js`

**Out of scope**:
- Rust backend crates (`inkwell/crates/`)

## Steps

### Step 1: Fix `ReferenceError` in `eraseStrokesAt` and Shift-key Ruler snapping math

In `inkwell-app/src/js/app.js`:
1. In `eraseStrokesAt(e)` (lines 500-506), update the `erase_strokes_near` IPC payload:
   - Replace `sheet: sheetIdx` with `sheet: targetSheet`
   - Replace `px: x` with `px: wx`
   - Replace `py: y` with `py: wy`
2. On line 757, fix the Shift-key snapping formula for Ruler lines:
   - Change `ey = state.shapeStart[0] + Math.sin(angle) * len;` to `ey = state.shapeStart[1] + Math.sin(angle) * len;`

**Verify**: Run `py -3 tools/validate.py` -> exit 0.

### Step 2: Cache stage `getBoundingClientRect()` to eliminate layout thrashing

In `inkwell-app/src/js/app.js` and `inkwell-app/src/js/viewport.js`:
1. Maintain a cached stage bounding box `stageRect` updated during `resize()` and `scroll` event listeners.
2. In `localXY()`, `paneForEvent()`, and `viewport.js` pointer handlers, use the cached `stageRect` instead of invoking `wetCanvas.getBoundingClientRect()` on high-frequency pointer movements.

**Verify**: Run `cd inkwell-m0 && py -3 test_smoke.py` -> exit 0.

### Step 3: Debounce `redrawAll()` via `requestAnimationFrame`

In `inkwell-app/src/js/app.js`:
1. Add a `scheduleRedrawAll()` function that debounces `redrawAll()` calls using `requestAnimationFrame`, similar to `scheduleRedrawTiles()`.
2. Update `ViewportManager`'s `onChange` callback to call `scheduleRedrawAll()` instead of synchronous `redrawAll()`.

**Verify**: Run `py -3 tools/validate.py` -> exit 0.

## Test plan

- Test stroke erasing by drawing strokes and verifying no JS exceptions are thrown when erasing.
- Test Shift-key ruler drawing to verify straight horizontal, vertical, and diagonal lines lock correctly without offset distortion.

## Done criteria

- [ ] `eraseStrokesAt` passes `targetSheet`, `wx`, `wy` to `erase_strokes_near` IPC without errors.
- [ ] Shift-key ruler Y math uses `state.shapeStart[1]`.
- [ ] `redrawAll()` is debounced using `requestAnimationFrame`.
- [ ] `plans/README.md` updated.

## STOP conditions

- If `stageRect` cache causes coordinate misalignment when scrolling external window containers, invalidate cache on scroll and report.
