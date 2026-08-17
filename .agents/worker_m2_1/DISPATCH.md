## 2026-08-14T13:17:40Z
You are worker_m2_1, working on Milestone 2: Zero-Latency Inking, GPU Canvas & Spatial Indexing for InkWell.
Working Directory: d:\Own Programs\InkWell\.agents\worker_m2_1\
Parent: sub_orch_m2_gen2 (Conversation ID: 78a64340-487c-4665-b9ca-c3fadefda659)

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. An auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Context & Instructions:
Read:
- d:\Own Programs\InkWell\.agents\ORIGINAL_REQUEST.md
- d:\Own Programs\InkWell\AGENTS.md
- d:\Own Programs\InkWell\plans\020-pen-latency-dom-layout-and-path2d-caching.md
- d:\Own Programs\InkWell\plans\025-spatial-indexing-eraser-lasso-and-thumbnail-virtualization.md
- d:\Own Programs\InkWell\.agents\sub_orch_m2_gen2\SCOPE.md

Your Task:
Implement the complete Milestone 2 solution across:
1. Zero-reflow inking hot loop:
   - In `inkwell-app/src/js/app.js`: Cache `stageRect` updates during window resize, drawer transitions, and scroll events; eliminate forced layout reflows (`getBoundingClientRect`) inside `localXY` and `paneForEvent` during pointer moves when cached `stageRect` is valid.
   - Remove `updateStats(e.pointerType)` from `consume(e)`. Run `updateStats` at most on `onUp` (or throttled via a timer), and ensure `const el = $('inputStats'); if (el) { ... }` guards against null.
2. Zero-allocation event samples & precomputed color:
   - In `inkwell-app/src/js/ink.js`: Precompute `this.cssColor = \`rgb(${this.rgb.map(v => Math.round(v * 255)).join(',')})\`;` in the `Stroke` constructor.
   - In `Stroke.prototype.push`, store numerical samples directly `this.samples.push([fx, fy, this._p, tMs]);` without `.toFixed()` conversions.
   - In `inkwell-app/src/js/app.js` in `consume(e)`: use `wctx.fillStyle = state.cur.cssColor;`.
   - In `inkwell-app/src/js/ink.js` in `drawStroke`: use `stroke.cssColor` to avoid per-render string reconstruction.
3. Triple-buffer canvas pipeline & Path2D retention:
   - In `inkwell-app/src/js/app.js` in `onUp(e)`: eagerly generate and cache `finishedStroke._cachedPath2D = Ink.getPath2D(finishedStroke);`.
   - Compute the stroke's bounding box `[minX - pad, minY - pad, maxX + pad, maxY + pad]` and clear only the dirty rect on `wetCanvas` (`wctx.clearRect(...)`) or call `clearWet()` if transformed.
   - In `inkwell-app/src/js/ink.js` in `drawStroke`: fast-path `if (stroke._cachedPath2D) { ctx.fill(stroke._cachedPath2D); return; }` to bypass polyline subdivision during document redraws.
4. Point processing math:
   - Ensure One-Euro filter tuning (Casiez CHI 2012 parameters: min cutoff ~1.0-1.2, beta ~0.005-0.007, dcutoff 1.0).
   - Centripetal Catmull-Rom cubic Bezier curve fitting with 3-point boundary derivatives for smooth ribbons.
   - Pressure-aware RDP ($|\Delta p| > 0.08$) so pressure nuances are preserved without point bloat.
5. Spatial AABB indexing:
   - In `inkwell-app/src/js/ink.js`: In `Stroke` constructor or `onUp` in `app.js`, compute and maintain `stroke.bbox = [minX - r, minY - r, maxX + r, maxY + r]` where `r = stroke.base_width || 2.0`.
   - In `inkwell-app/src/js/app.js`: In `eraseStrokesAt(wx, wy, radius)`: check if query circle `[wx - radius, wy - radius, wx + radius, wy + radius]` intersects `stroke.bbox` in O(1). Skip points iteration entirely for non-intersecting strokes.
   - In `findObjectAtWorld(wx, wy)`: pre-filter with `stroke.bbox`.
   - In lasso selection: check bounding box intersection before testing polygon containment.
   - In `inkwell/crates/inkwell-core/src/doc.rs`: Add `pub fn bbox(&self) -> [f64; 4]` on `Stroke` and pre-filter strokes in `erase_strokes_near` and `erase_strokes_in_rect`.
6. Virtualized thumbnail drawer:
   - In `inkwell-app/src/js/app.js` in `renderThumbnails()`:
     - Compute total virtual scroll height (`pageCount * itemHeight`) on the thumbnail container.
     - Attach a scroll listener to `$('drawerThumbnails')`. On scroll (throttled via rAF), calculate the visible page range `[startIndex, endIndex]` (with 5 items buffer).
     - Render and mount only DOM cards within the visible range; reuse a single offscreen canvas for thumbnail bitmap generation.
     - Index strokes by sheet `strokesBySheet.get(sheetIndex)` so thumbnail rendering never scans the entire document stroke list.
7. Plan status update:
   - Mark Plan 020 and Plan 025 as `DONE` in `plans/README.md`.
