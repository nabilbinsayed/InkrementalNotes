# Scope: Milestone 2 — Zero-Latency Inking, GPU Canvas & Spatial Indexing

## Architecture
- Frontend Inking Pipeline: `inkwell-app/src/js/app.js`, `inkwell-app/src/js/ink.js`, `inkwell-app/src/js/viewport.js`
- Core Rust Document & Spatial Logic: `inkwell/crates/inkwell-core/src/doc.rs`, `inkwell/crates/inkwell-core/src/ink.rs`

## Feature Inventory
| # | Feature | Description | Status |
|---|---------|-------------|--------|
| F01 | Zero-Reflow Inking Loop | Cache stageRect, eliminate getBoundingClientRect and updateStats per pointer sample | IN_PROGRESS |
| F02 | Zero-Allocation Event Samples | Precomputed cssColor, raw float arrays in Stroke.push (no toFixed strings) | IN_PROGRESS |
| F03 | Triple-Buffer & Path2D Retention | Cached _cachedPath2D, dirty damage rect clearing on pen-up | IN_PROGRESS |
| F17 | Spatial AABB Indexing | Axis-Aligned Bounding Box caching in JS and Rust for O(1) hit rejection in eraser, lasso, selection | IN_PROGRESS |
| F18 | Virtualized Thumbnail Drawer | DOM recycling for page thumbnails, sheet-indexed stroke filtering | IN_PROGRESS |

## Interface Contracts & Requirements
1. **Zero-Reflow Inking**:
   - `consume(e)` in `app.js` must NEVER call `getBoundingClientRect()` or `updateStats()` per sample.
   - `stageRect` cached and refreshed on resize/scroll/drawer transitions.
   - `updateStats` runs at most once on `onUp` or throttled.
2. **Zero-Allocation**:
   - `Stroke.prototype.push` stores `[fx, fy, p, tMs]` directly as numerical floats.
   - `this.cssColor = \`rgb(${this.rgb.map(v => Math.round(v * 255)).join(',')})\`;` precomputed in `Stroke` constructor.
   - `drawStroke` and `consume` use `stroke.cssColor` without string reconstruction.
3. **Path2D & Dirty Rect**:
   - `stroke._cachedPath2D = Ink.getPath2D(stroke)` populated eagerly on `onUp`.
   - `drawStroke` uses fast-path `ctx.fill(stroke._cachedPath2D)` when available.
   - `onUp` calculates stroke bbox and clears only the dirty region or calls `clearWet()`.
4. **Point Processing Math**:
   - One-Euro filter tuning (min cutoff, beta parameters per Casiez CHI 2012).
   - Centripetal Catmull-Rom cubic Bezier curve fitting with 3-point boundary derivatives.
   - Pressure-aware RDP ($|\Delta p| > 0.08$) preserving pressure nuances without point bloat.
5. **Spatial AABB Indexing**:
   - In JS `ink.js` & `app.js`: `stroke.bbox = [minX - r, minY - r, maxX + r, maxY + r]`.
   - In `eraseStrokesAt`, `findObjectAtWorld`, and lasso selection: test bounding box intersection before scanning points.
   - In Rust `inkwell-core/src/doc.rs`: Add `pub fn bbox(&self) -> [f64; 4]` on `Stroke` and pre-filter strokes in `erase_strokes_near` and `erase_strokes_in_rect`.
6. **Virtualized Thumbnail Drawer**:
   - `renderThumbnails()` computes total virtual height, mounts only visible viewport items (+ 5 buffer items).
   - Reuses offscreen canvas and indexes strokes by sheet (`strokesBySheet`).
