# Plan 050: Inking Pipeline Streamlining, Spatial Eraser & Lasso Matrix Transformations

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat bd18cc4..HEAD -- inkwell-app/src/js/tools/pen.js inkwell-app/src/js/tools/eraser.js inkwell-app/src/js/tools/lasso.js inkwell-app/src/js/workspace/scrollbar.js`
> Confirm live code matches the excerpts below; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf / inking
- **Planned at**: commit `bd18cc4`, 2026-09-03

## Why this matters

High-frequency drawing and gesture interactions suffer from bypassed optimizations and unnecessary per-event recomputations:
1. In `pen.js`, `consumeFilteredPoint()` directly pushes raw `{ x, y, p, w, t }` objects into `state.cur.points`, completely bypassing `Stroke.push()`. This circumvents the One-Euro position filter, pressure EMA, initial pen-down pressure spike warmup suppression, and sub-0.05px jitter deduplication. As a result, stroke point counts are inflated, increasing memory footprint and causing subtle pen jitter.
2. In `eraser.js`, `eraseStrokesAt()` scans `state.strokes` across the entire multi-page document on every pointer move event at 240Hz, invokes `documentOps.deleteStrokes()` synchronously (triggering `rebuildStrokesBySheet()` full index rebuilds per hit), and synchronously executes `compositor.redrawAll()`. On large documents with thousands of strokes, erasing stutters below 15fps.
3. In `lasso.js`, dragging, rotating, or scaling a selection re-runs `getPath2D(s)` and `chaikinSubdivide(rawPts, 2)` across all selected strokes on every single mousemove event, generating massive GC pressure and frame drops.
4. In `scrollbar.js`, `updateDocScrollbar()` performs forced DOM reflows (`track.clientHeight`) synchronously during wheel scrolling.

## Current state

- `inkwell-app/src/js/tools/pen.js`:
  ```javascript
  // Lines 111-114:
  const pt = { x: px, y: py, p, w, t };
  if (!state.cur.points) state.cur.points = [];
  state.cur.points.push(pt);
  ```
- `inkwell-app/src/js/ink.js`:
  ```javascript
  // Lines 104-128:
  push(x, y, pressure, tMs) {
    this._warmup++;
    let p = pressure;
    if (this._warmup <= 2) p = Math.min(p, 0.35);
    const fx = this._smoothing ? this._fx.filter(x, tMs) : x;
    const fy = this._smoothing ? this._fy.filter(y, tMs) : y;
    this._p = this._p === null ? p : this._p + 0.35 * (p - this._p);
    const last = this._pts[this._pts.length - 1];
    if (last && Math.hypot(fx - last.x, fy - last.y) < 0.05) return null;
    const w = this.widthFor(this._p);
    const pt = { x: fx, y: fy, w, p: this._p, t: tMs };
    this._pts.push(pt);
    this.samples.push([fx, fy, this._p, tMs]);
    ...
    return pt;
  }
  ```
- `inkwell-app/src/js/tools/eraser.js`:
  ```javascript
  // Lines 34-36:
  for (const s of state.strokes) {
    if (s.deleted) continue;
  ```
- `inkwell-app/src/js/tools/lasso.js`:
  ```javascript
  // Lines 312-315, 384-387, 467-470:
  s._cachedPath2D = window.Ink.getPath2D(s);
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Frontend syntax check | `node --check inkwell-app/src/js/tools/pen.js && node --check inkwell-app/src/js/tools/eraser.js && node --check inkwell-app/src/js/tools/lasso.js` | exit 0 |
| Rust workspace test | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |

## Scope

**In scope**:
- `inkwell-app/src/js/tools/pen.js`
- `inkwell-app/src/js/tools/eraser.js`
- `inkwell-app/src/js/tools/lasso.js`
- `inkwell-app/src/js/workspace/scrollbar.js`

**Out of scope**:
- Do not alter `inkwell/crates/inkwell-core/src/ink.rs` algorithm definitions.
- Do not change the serialized stroke JSON schema.

## Steps

### Step 1: Route Inking Pointer Events through `Stroke.push` in `pen.js`

In `inkwell-app/src/js/tools/pen.js::consumeFilteredPoint()`:
1. Replace direct point construction and push with `state.cur.push(px, py, p, t)`.
2. If `state.cur.push` returns `null` (deduplicated sample under 0.05px distance threshold), return early without drawing a redundant zero-length segment:
   ```javascript
   function consumeFilteredPoint(px, py, p, t, pane, viewport) {
     const { wctx } = compositor.getContexts();
     if (!wctx || !state.cur) return;

     let pt;
     if (typeof state.cur.push === 'function') {
       pt = state.cur.push(px, py, p, t);
       if (!pt) return; // Deduplicated jitter
     } else {
       const baseW = state.cur.base_width || state.cur.baseWidth || state.baseWidth || 1.6;
       const isHighlighter = state.cur.kind === 'highlighter';
       const c = Math.pow(Math.max(0, Math.min(1, p)), 1.0);
       const w = isHighlighter ? baseW : baseW * (0.22 + 0.78 * c);
       pt = { x: px, y: py, p, w, t };
       if (!state.cur.points) state.cur.points = [];
       state.cur.points.push(pt);
     }
   ```
3. Continue drawing the incremental segment to `wctx`.

**Verify**: `node --check inkwell-app/src/js/tools/pen.js` → exit 0.

### Step 2: Optimize Eraser with Sheet Scoping and Gesture Batching

In `inkwell-app/src/js/tools/eraser.js`:
1. Limit hit testing to strokes on the active sheet:
   ```javascript
   const sheetStrokes = documentOps.getStrokesForSheet(activeSheet);
   for (const s of sheetStrokes) {
     if (s.deleted) continue;
     // AABB rejection using s.bbox
   ```
2. Track an accumulated `erasedInGesture = new Set()` across the pointer drag gesture.
3. During pointermove:
   - Mark hit strokes `s.deleted = true` in memory and add to `erasedInGesture`.
   - Coalesce dry canvas repaints using `compositor.scheduleRedrawAll()` rather than synchronous `redrawAll()`.
4. On `onEraserUp`:
   - If `erasedInGesture.size > 0`, dispatch a single batched `documentOps.deleteStrokes(Array.from(erasedInGesture))` transaction to history and backend IPC.

**Verify**: `node --check inkwell-app/src/js/tools/eraser.js` → exit 0.

### Step 3: Defer Lasso Path2D Regeneration via Canvas Transform Matrix

In `inkwell-app/src/js/tools/lasso.js`:
1. During active drag, rotation, or scale gestures, do NOT re-map stroke point arrays and do NOT call `getPath2D()` on pointermove.
2. Clear and render the active selection on `wetCanvas` by applying 2D canvas matrix transformations (`ctx.translate`, `ctx.rotate`, `ctx.scale`) and rendering existing `s.getPath2D()`:
   ```javascript
   // Apply affine transform on wet canvas:
   wctx.save();
   wctx.translate(cx, cy);
   wctx.rotate(currentAngle);
   wctx.scale(currentScaleX, currentScaleY);
   wctx.translate(-cx, -cy);
   // Draw existing cached Path2D objects
   for (const s of state.selectedStrokes) {
     wctx.fillStyle = s.cssColor;
     wctx.fill(s.getPath2D());
   }
   wctx.restore();
   ```
3. Only upon pointer release (`onLassoUp`), bake the affine transform into stroke points once, invalidate `_cachedPath2D`, and commit the transaction.

**Verify**: `node --check inkwell-app/src/js/tools/lasso.js` → exit 0.

### Step 4: Decouple Scrollbar Updates from Forced DOM Layouts

In `inkwell-app/src/js/workspace/scrollbar.js`:
1. Cache `trackHeight` on window resize and observer callbacks rather than reading `track.clientHeight` during wheel events.
2. Batch style updates to `thumb.style.transform = translateY(...)` or RAF-coalesced style updates.

**Verify**: `node --check inkwell-app/src/js/workspace/scrollbar.js` → exit 0.

## Test plan

1. Automated checks:
   - `node --check` across modified files.
   - `cd inkwell && cargo test --workspace -- --test-threads=1`.
2. Manual verification:
   - Draw rapid handwriting strokes: verify smooth pressure curves with no jitter.
   - Erase across 50+ strokes: verify 60fps+ fluid erasing without dropped frames.
   - Select 20+ strokes with lasso and rotate/scale: verify smooth real-time preview without CPU stutter.

## Done criteria

- [ ] `pen.js` uses `Stroke.push` to restore One-Euro filter and jitter deduplication.
- [ ] Eraser restricts scans to `activeSheet` and batches deletions per gesture.
- [ ] Lasso transformation uses canvas matrix transforms on wet canvas during drag/rotate/scale.
- [ ] Scrollbar updates avoid synchronous layout thrashing.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If stroke coordinates drift between wet canvas and dry canvas during inking, stop and verify `psx, psy` translation.
