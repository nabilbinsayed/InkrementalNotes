# Plan 024: Touch & Stylus Ergonomics: Palm Rejection, Pinch-to-Zoom, Drawer Animations, and Chisel Geometry

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1154947..HEAD -- inkwell-app/src/js/app.js inkwell-app/src/js/viewport.js inkwell-app/src/js/ink.js inkwell-app/src/styles.css`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 020
- **Category**: direction
- **Planned at**: commit `1154947`, 2026-08-14

## Why this matters

1. On stylus-enabled touchscreens, palm contact currently initiates unexpected touch strokes that clobber active pen strokes.
2. Standard multi-touch pinch-to-zoom gestures are missing from `ViewportManager`.
3. Navigation drawer CSS animations are cancelled by `.hidden { display: none !important; }`, causing abrupt pop-in and canvas flicker.
4. Chisel highlighter paths collapse on vertical strokes because `getChiselPath2D` assumes strictly horizontal motion.
5. Laser pointer decay terminates abruptly on `pointerup`.

Resolving these issues elevates InkWell to an Apple-grade, responsive, tactile annotator.

## Current state

- `inkwell-app/src/js/app.js:1616-1618, 1739` — `onDown(e)` accepts touch input unconditionally, overwriting active pen strokes when a palm touches the screen.
- `inkwell-app/src/js/viewport.js:268-317` — Viewport listens only to wheel and middle mouse; no two-pointer pinch tracking.
- `inkwell-app/src/styles.css:175-179, 2004` — `.nav-drawer.hidden` has transitions overridden by `.hidden { display: none !important; }`.
- `inkwell-app/src/js/ink.js:147-166` — `getChiselPath2D` adds constant `+- halfH` to `y` without using trajectory normal vectors.
- `inkwell-app/src/js/app.js:1970-1973` — `onUp` calls `clearLaser()` immediately, killing the 1.2-second trail fade animation.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test -- --test-threads=1` | exit 0, all 48 tests pass |

## Scope

**In scope**:
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/js/ink.js`
- `inkwell-app/src/styles.css`

**Out of scope**:
- Rust core inking logic.

## Git workflow

- Branch: `advisor/024-touch-and-motion-ergonomics`
- Commit per step; message style: `feat(ui): <description>`

## Steps

### Step 1: Implement Palm Rejection and Stylus Isolation

In `inkwell-app/src/js/app.js`:
1. In `onDown(e)`:
   - Track active pointer devices. If a `'pen'` pointer is active or drawing, ignore any incoming `'touch'` pointer events on the drawing canvas.
   - If `'touch'` pointer arrives when no pen is active, allow touch-based panning or touch drawing based on user preference setting.
2. In `onMove(e)` / `onUp(e)`:
   - Match event `pointerId` with `activePointerId` to avoid cross-pointer event pollution.

**Verify**: Run `cd inkwell-m0; py -3 test_smoke.py` → 18/18 checks pass.

### Step 2: Implement Multi-Touch Pinch-to-Zoom Gesture in `ViewportManager`

In `inkwell-app/src/js/viewport.js`:
1. Maintain an active touch map `this.activeTouches = new Map();` on the stage element.
2. On `pointerdown` (type `'touch'`), add pointer to map. If 2 touches are active:
   - Calculate initial distance between touch points `d0 = Math.hypot(p1.x - p2.x, p1.y - p2.y)` and midpoint.
3. On `pointermove` with 2 active touches:
   - Compute `d1 / d0` scale factor and adjust viewport zoom smoothly centered on the midpoint.
4. On `pointerup` / `pointercancel`: remove pointer from map.

**Verify**: Test pinch-to-zoom in browser/device emulator: zooming scales smoothly around gesture center without creating stroke annotations.

### Step 3: Fix Drawer Slide Transitions and Smooth Laser Decay Physics

1. In `inkwell-app/src/styles.css`:
   - Replace `.nav-drawer.hidden` with `.nav-drawer.collapsed { margin-left: -280px; opacity: 0; pointer-events: none; }` and remove the `.hidden` class from `.nav-drawer` elements in `index.html`.
   - Ensure `transition: margin-left 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;` executes smoothly without `display: none` interruption.
2. In `inkwell-app/src/js/app.js`:
   - In `onUp(e)` for `activeTool === 'laser'`: set `state.isLaserDown = false` instead of calling `clearLaser()`. Allow `updateLaserAnimation()` to fade remaining trail points to alpha 0 naturally before stopping the RAF loop.

**Verify**: Toggle navigation drawers: panels slide open and closed with fluid spring animations. Draw laser trail: trail fades smoothly over 1.2 seconds after pointer release.

### Step 4: Fix Chisel Highlighter Path Normal Vector Mathematics

In `inkwell-app/src/js/ink.js`:
1. In `getChiselPath2D(rawPts, baseH)`:
   - Compute the chisel ribbon using a 45-degree angled nib vector `(cos(45°), sin(45°))` or path normal offsets `(nx, ny)`:
   ```javascript
   const angle = Math.PI / 4; // 45 degree chisel angle
   const hx = (halfH * Math.cos(angle));
   const hy = (halfH * Math.sin(angle));
   // Top contour: (pts[i].x + hx, pts[i].y - hy)
   // Bottom contour: (pts[i].x - hx, pts[i].y + hy)
   ```
   - Build a closed polygon connecting top and bottom contours with flat angled end-caps.

**Verify**: Draw horizontal, vertical, and diagonal highlighter strokes: ribbon maintains consistent angled chisel geometry regardless of stroke orientation.

## Test plan

- Test dual-touch pinch gesture on touchscreen: document zooms and pans with momentum.
- Test stylus with palm resting on screen: only pen creates ink; palm is ignored.
- Test drawer toggle: no canvas flicker or abrupt layout jumps.
- Test chisel highlighter at 0°, 45°, and 90° stroke angles.

## Done criteria

- [ ] Palm contact does not interrupt stylus strokes
- [ ] Two-finger pinch gesture smoothly zooms viewport
- [ ] Navigation drawer animates with smooth CSS transition
- [ ] Laser pointer trail decays smoothly after pen up
- [ ] Chisel highlighter produces valid polygons on vertical strokes

## STOP conditions

- If pointer capture on `wetCanvas` intercepts touch gestures before `ViewportManager`, route touch events through a unified gesture coordinator.

## Maintenance notes

- All future animated panels should use CSS transform/opacity or dedicated transition classes rather than global `.hidden` toggles.
