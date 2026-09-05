# Plan 054: Enforce Horizontal Pan Clamping in Viewport Zoom and Pinch Handlers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3f3e8d..HEAD -- inkwell-app/src/js/viewport.js inkwell-app/test_app_smoke.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3f3e8d`, 2026-09-05

## Why this matters

In `inkwell-app/src/js/viewport.js`, `setZoom` and the two-finger touch pinch-zoom gesture calculate a focal-point pan offset (`newPanX` / `targetPanX`) so that the point under the cursor or pinch midpoint remains stationary. While vertical panning is clamped via `this.clampPanY(newPanY)`, horizontal panning directly assigns `this.panX = newPanX` or `this.panX = targetPanX` without calling `clampPanX()`.

Consequently, repeated zoom-in/zoom-out cycles with off-center focal points (e.g. mouse wheel near screen edges or asymmetrical pinch gestures) cause the page to drift horizontally offscreen until the canvas is blank. Clamping `panX` with `this.clampPanX()` in all zoom pathways prevents runaway document drift while preserving natural focal zoom.

## Current state

The relevant files and lines:
- `inkwell-app/src/js/viewport.js` (lines 187–206, `clampPanX` method exists):
```javascript
  clampPanX(x, pane = 'left') {
    if (!this.maxDocWidth || !this.stageRect) return x;
    const isRight = pane === 'right' && this.splitMode;
    const z = isRight ? this.rightZoom : this.zoom;
    const totalW = this.stageRect ? this.stageRect.width : 800;
    const stageW = this.splitMode ? totalW / 2 : totalW;
    const docW = this.maxDocWidth * z;
    const hMargin = Math.max(80, stageW * 0.15);
    const offsetLeft = isRight ? stageW : 0;

    if (docW + 2 * hMargin <= stageW) {
      // Document fits horizontally with margin: clamp around centered position
      const centerX = offsetLeft + (stageW - docW) / 2;
      return Math.max(centerX - hMargin, Math.min(centerX + hMargin, x));
    }

    const minPanX = offsetLeft + stageW - docW - hMargin;
    const maxPanX = offsetLeft + hMargin;
    return Math.max(minPanX, Math.min(maxPanX, x));
  }
```

- `inkwell-app/src/js/viewport.js` (lines 228–249, `setZoom` without `clampPanX`):
```javascript
    if (centerPx && curZoom !== newZoom) {
      const scale = newZoom / curZoom;
      const newPanX = centerPx[0] - (centerPx[0] - curPanX) * scale;
      const newPanY = centerPx[1] - (centerPx[1] - curPanY) * scale;
      if (isRight) {
        this.rightZoom = newZoom;
        this.rightPanX = newPanX;
        this.rightPanY = this.clampPanY(newPanY, 'right');
      } else {
        this.zoom = newZoom;
        this.panX = newPanX;
        this.panY = this.clampPanY(newPanY, 'left');
      }
    } else {
      if (isRight) {
        this.rightZoom = newZoom;
        this.rightPanY = this.clampPanY(this.rightPanY, 'right');
      } else {
        this.zoom = newZoom;
        this.panY = this.clampPanY(this.panY, 'left');
      }
    }
```

- `inkwell-app/src/js/viewport.js` (lines 475–484, pinch gesture without `clampPanX`):
```javascript
          if (pane === 'right' && this.splitMode) {
            this.rightZoom = newZoom;
            this.rightPanX = targetPanX;
            this.rightPanY = this.clampPanY(targetPanY, 'right');
          } else {
            this.zoom = newZoom;
            this.panX = targetPanX;
            this.panY = this.clampPanY(targetPanY, 'left');
          }
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop App Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all checks pass |
| Rust Workspace Tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all pass |

## Scope

**In scope**:
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- Inking or tool modules
- Rust backend

## Steps

### Step 1: Clamp horizontal pan in `setZoom`

In `inkwell-app/src/js/viewport.js`, update `setZoom` so that `this.clampPanX(...)` is called for both `isRight` and `left` panes in both branches (with and without `centerPx`):

```javascript
    if (centerPx && curZoom !== newZoom) {
      const scale = newZoom / curZoom;
      const newPanX = centerPx[0] - (centerPx[0] - curPanX) * scale;
      const newPanY = centerPx[1] - (centerPx[1] - curPanY) * scale;
      if (isRight) {
        this.rightZoom = newZoom;
        this.rightPanX = this.clampPanX(newPanX, 'right');
        this.rightPanY = this.clampPanY(newPanY, 'right');
      } else {
        this.zoom = newZoom;
        this.panX = this.clampPanX(newPanX, 'left');
        this.panY = this.clampPanY(newPanY, 'left');
      }
    } else {
      if (isRight) {
        this.rightZoom = newZoom;
        this.rightPanX = this.clampPanX(this.rightPanX, 'right');
        this.rightPanY = this.clampPanY(this.rightPanY, 'right');
      } else {
        this.zoom = newZoom;
        this.panX = this.clampPanX(this.panX, 'left');
        this.panY = this.clampPanY(this.panY, 'left');
      }
    }
```

**Verify**:
`grep -rn "this.clampPanX" inkwell-app/src/js/viewport.js` → shows calls inside `setZoom`.

### Step 2: Clamp horizontal pan in touch pinch-zoom handler

In `inkwell-app/src/js/viewport.js`, locate the pinch-zoom branch in `onPointerMoveGlobal`:

Change:
```javascript
          if (pane === 'right' && this.splitMode) {
            this.rightZoom = newZoom;
            this.rightPanX = targetPanX;
            this.rightPanY = this.clampPanY(targetPanY, 'right');
          } else {
            this.zoom = newZoom;
            this.panX = targetPanX;
            this.panY = this.clampPanY(targetPanY, 'left');
          }
```

To:
```javascript
          if (pane === 'right' && this.splitMode) {
            this.rightZoom = newZoom;
            this.rightPanX = this.clampPanX(targetPanX, 'right');
            this.rightPanY = this.clampPanY(targetPanY, 'right');
          } else {
            this.zoom = newZoom;
            this.panX = this.clampPanX(targetPanX, 'left');
            this.panY = this.clampPanY(targetPanY, 'left');
          }
```

**Verify**:
`grep -rn "targetPanX" inkwell-app/src/js/viewport.js` → shows wrapped with `clampPanX`.

### Step 3: Add pan-clamping smoke test in `test_app_smoke.py`

In `inkwell-app/test_app_smoke.py`, add a test in the zoom section that invokes `viewport.setZoom(3.0, [2000, 500])` (focal point far to the right) and verifies that `viewport.panX` remains bounded by `clampPanX()` rather than exploding into runaway negative values.

**Verify**:
`cd inkwell-app; py -3 test_app_smoke.py` → exit 0, all checks pass.

## Test plan

- Test: Test extreme off-center focal zooms (`setZoom(0.5, [-500, 0])`, `setZoom(4.0, [5000, 0])`) and verify `viewport.panX === viewport.clampPanX(viewport.panX)`.
- Verification command: `cd inkwell-app; py -3 test_app_smoke.py`

## Done criteria

Machine-checkable. ALL must hold:
- [ ] In `viewport.js`, no assignment `this.panX = newPanX` exists without `this.clampPanX`.
- [ ] In `viewport.js`, no assignment `this.panX = targetPanX` exists without `this.clampPanX`.
- [ ] `cd inkwell-app; py -3 test_app_smoke.py` exits 0 with all checks passing.
- [ ] No files outside `inkwell-app/src/js/viewport.js` and `inkwell-app/test_app_smoke.py` are modified (`git status`).
- [ ] `plans/README.md` status row updated for Plan 054.

## STOP conditions

Stop and report back (do not improvise) if:
- `viewport.js` does not have a `clampPanX` method.
- `setZoom` signature in `viewport.js` does not match `(z, centerPx, pane)`.

## Maintenance notes

- Any future camera/viewport animations (e.g. smooth zoom interpolations) must route their intermediate `panX` updates through `clampPanX`.
