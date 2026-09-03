# Plan 048: Viewport Engine Geometry & Tile Rasterization Scale Clamping

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat bd18cc4..HEAD -- inkwell-app/src/js/viewport.js inkwell-app/src-tauri/src/commands.rs inkwell-app/src/js/render/compositor.js`
> Confirm live code matches the excerpts below; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf / correctness
- **Planned at**: commit `bd18cc4`, 2026-09-03

## Why this matters

Two critical geometric bugs degrade viewport interaction and cause sudden memory exhaustion:
1. In `viewport.js`, `this.element = null` is never assigned inside `attachListeners()` (it assigns `this.stageElement = element` instead). Consequently, `this.stageRect` is permanently `null`. `clampPanX()` aborts immediately on `if (!this.stageRect) return x;`, completely disabling horizontal pan boundary clamping. Concurrently, `clampPanY()` and page visibility calculations repeatedly fall back to hardcoded 800x600 dimensions and trigger repeated rect recalculations. Additionally, when documents are narrower than the viewport (`docW < stageW`), `clampPanX`'s `Math.max(minPanX, Math.min(maxPanX, x))` inverts (`minPanX > maxPanX`), locking horizontal panning, and split-mode right pane pans lack the `halfW` offset.
2. In `commands.rs::render_tile`, `scale` is computed as `((px as f64) / rw.max(rh)).min(16.0)` using the clipped tile rectangle dimensions (`rw`, `rh`) rather than the uniform page zoom. For narrow edge/corner tiles (e.g. 20pt boundary strip), `scale` spikes to 16.0, forcing PDFium to allocate an 8192x8192 uncompressed 268MB page bitmap for a tiny boundary strip. Across cache slots, this triggers multi-gigabyte memory spikes and stutter.
3. In `compositor.js`, `_redrawTilesPending` is cleared at the start of RAF before `redrawTiles()` finishes, and `drawEpoch` is never verified, leading to race conditions where stale tiles overwrite newly rendered ones.

## Current state

- `inkwell-app/src/js/viewport.js`:
  ```javascript
  // Line 21:
  this.element = null;
  // Line 36-39:
  updateStageRect() {
    if (this.element) {
      this.stageRect = this.element.getBoundingClientRect();
    }
  }
  // Line 187-200:
  clampPanX(x, pane = 'left') {
    if (!this.maxDocWidth || !this.stageRect) return x;
    const isRight = pane === 'right' && this.splitMode;
    const z = isRight ? this.rightZoom : this.zoom;
    const totalW = this.stageRect ? this.stageRect.width : 800;
    const stageW = this.splitMode ? totalW / 2 : totalW;
    const docW = this.maxDocWidth * z;
    const hMargin = Math.max(80, stageW * 0.15);

    const maxPanX = hMargin;
    const minPanX = stageW - docW - hMargin;
    return Math.max(minPanX, Math.min(maxPanX, x));
  }
  // Line 339:
  attachListeners(element) {
    this.stageElement = element;
    this.updateStageRect();
  ```
- `inkwell-app/src-tauri/src/commands.rs`:
  ```rust
  // Line 504-507:
  let rw = (rect[2] - rect[0]).max(1.0);
  let rh = (rect[3] - rect[1]).max(1.0);
  let scale = ((px as f64) / rw.max(rh)).min(16.0);
  ```
- `inkwell-app/src/js/render/compositor.js`:
  ```javascript
  // Line 131-134:
  requestAnimationFrame(() => {
    _redrawTilesPending = false;
    redrawTiles();
  });
  // Line 139:
  const drawEpoch = ++_redrawTilesEpoch;
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Frontend syntax check | `node --check inkwell-app/src/js/viewport.js && node --check inkwell-app/src/js/render/compositor.js` | exit 0 |
| Rust backend check | `cd inkwell-app/src-tauri && cargo check` | exit 0 |
| Core workspace test | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |

## Scope

**In scope**:
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/render/compositor.js`

**Out of scope**:
- Do not modify tile grid layout formulas in `tiles.js`.
- Do not change the IPC method signature of `render_tile`.

## Steps

### Step 1: Assign `this.element = element` and correct `clampPanX` bounds in `viewport.js`

1. In `attachListeners(element)` (`viewport.js:339`):
   ```javascript
   this.element = element;
   this.stageElement = element;
   ```
2. In `clampPanX(x, pane = 'left')` (`viewport.js:187-200`):
   - Account for `pane === 'right'` offset: `const offsetLeft = isRight ? stageW : 0;`.
   - When document width is less than stage width (`docW + 2 * hMargin < stageW`), allow centering or bounded panning between `offsetLeft + (stageW - docW) / 2 - hMargin` and `offsetLeft + (stageW - docW) / 2 + hMargin`.
   - When document width exceeds stage width, clamp between `offsetLeft + stageW - docW - hMargin` (minimum pan) and `offsetLeft + hMargin` (maximum pan).
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

**Verify**: `node --check inkwell-app/src/js/viewport.js` → exit 0.

### Step 2: Fix tile rasterization scale calculation in `commands.rs`

In `commands.rs::render_tile` (lines 504-507):
Replace the per-tile `rw.max(rh)` denominator with uniform tile grid scale.
In InkWell, standard tiles are requested for 256pt grid units (`TILE_SIZE_PT = 256.0`). Boundary tiles are simply smaller sub-rectangles of the standard grid unit.
Compute scale using the standard tile grid unit or max of page-level resolution:
```rust
let tile_pt = 256.0_f64;
let scale = ((px as f64) / tile_pt).clamp(0.1, 4.0);
```
Ensure `target_w` and `target_h` cannot exceed 4096 pixels (bounding uncompressed memory to 64 MB per cached page bitmap instead of 256 MB):
```rust
let target_w = ((page_w * scale).round().max(1.0) as i32).min(4096);
let target_h = ((page_h * scale).round().max(1.0) as i32).min(4096);
```

**Verify**: `cd inkwell-app/src-tauri && cargo check` → exit 0.

### Step 3: Implement draw epoch checking in `compositor.js`

In `compositor.js`:
1. In `scheduleRedrawTiles()`: keep `_redrawTilesPending = true` until `redrawTiles()` finishes (or clear inside `finally`):
   ```javascript
   export function scheduleRedrawTiles() {
     if (_redrawTilesPending) return;
     _redrawTilesPending = true;
     requestAnimationFrame(async () => {
       try {
         await redrawTiles();
       } finally {
         _redrawTilesPending = false;
       }
     });
   }
   ```
2. In `redrawTiles()`:
   Record `drawEpoch`. After `await Promise.all(...)` at line 151, check:
   ```javascript
   if (drawEpoch !== _redrawTilesEpoch) {
     return; // Stale render superseded by a newer draw request; drop
   }
   ```

**Verify**: `node --check inkwell-app/src/js/render/compositor.js` → exit 0.

## Test plan

1. Automated checks:
   - `node --check inkwell-app/src/js/viewport.js`
   - `node --check inkwell-app/src/js/render/compositor.js`
   - `cd inkwell-app/src-tauri && cargo check`
2. Functional manual tests:
   - Pan horizontally when zoomed out: verify document does not snap to edge or freeze.
   - Toggle split view: verify right pane centers correctly and pans smoothly within right half bounds.
   - Zoom in to 400% on a boundary corner: verify memory consumption remains under 150MB and does not spike to 4GB.

## Done criteria

- [ ] `this.element = element` assigned in `viewport.js:attachListeners`.
- [ ] `clampPanX` supports both document narrower than viewport and split mode right pane offset without freezing.
- [ ] `scale` in `commands.rs::render_tile` is clamped to reasonable uniform zoom bounds and bitmap size is capped at 4096.
- [ ] `drawEpoch` validation prevents concurrent stale tile redraws in `compositor.js`.
- [ ] `cargo check` and `node --check` exit 0.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If changing `element` breaks existing touch event bindings, stop and report.
- If tile alignment in `tiles.js` exhibits sub-pixel seams after scale clamping, stop and verify `TILE_SIZE_PT`.
