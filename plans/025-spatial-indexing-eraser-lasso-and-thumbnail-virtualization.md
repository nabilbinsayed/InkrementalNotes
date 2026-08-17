# Plan 025: Spatial Indexing for Eraser/Lasso Hit-Testing and Thumbnail DOM Virtualization

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1154947..HEAD -- inkwell-app/src/js/app.js inkwell/crates/inkwell-core/src/doc.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 020
- **Category**: perf
- **Planned at**: commit `1154947`, 2026-08-14

## Why this matters

On documents with hundreds of annotations, `eraseStrokesAt`, `findObjectAtWorld`, and lasso selection perform O(N*M) linear distance calculations on every pointer move, causing noticeable stutter during eraser swipes. Furthermore, opening the page thumbnail drawer on a 500-page document mounts 500 simultaneous DOM cards and canvas elements, exhausting GPU texture memory and freezing the UI thread for several seconds. Caching stroke bounding boxes (AABB) and virtualizing thumbnail DOM elements ensures instant hit detection and lag-free thumbnail navigation.

## Current state

- `inkwell-app/src/js/app.js:718-742` — `eraseStrokesAt` iterates over all strokes and all sample points without AABB pre-filtering.
- `inkwell-app/src/js/app.js:902-934` — `findObjectAtWorld` loops over all strokes linearly.
- `inkwell-app/src/js/app.js:2020-2026` — Lasso commit checks `pointInPolygon` across all points of all strokes.
- `inkwell-app/src/js/app.js:3036-3089` — `renderThumbnails()` creates and renders all page DOM nodes and canvas elements in one synchronous burst.
- `inkwell/crates/inkwell-core/src/doc.rs:159-193` — Rust `erase_strokes_near` and `erase_strokes_in_rect` loop over all points without bounding box pruning.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test -- --test-threads=1` | exit 0, all 48 tests pass |

## Scope

**In scope**:
- `inkwell-app/src/js/app.js`
- `inkwell/crates/inkwell-core/src/doc.rs`

## Git workflow

- Branch: `advisor/025-spatial-indexing-and-virtualization`
- Commit per step; message style: `perf(spatial): <description>`

## Steps

### Step 1: Compute and cache Axis-Aligned Bounding Boxes (AABB) on strokes

1. In `inkwell-app/src/js/ink.js`:
   - In `Stroke` (or `onUp` in `app.js`), compute `stroke.bbox = [minX - r, minY - r, maxX + r, maxY + r]` where `r = stroke.base_width || 2.0`.
2. In `inkwell-app/src/js/app.js`:
   - In `eraseStrokesAt(wx, wy, radius)`: check if query circle `[wx - radius, wy - radius, wx + radius, wy + radius]` intersects `stroke.bbox` in O(1). Skip points iteration entirely for non-intersecting strokes.
   - In `findObjectAtWorld(wx, wy)`: pre-filter with `stroke.bbox`.
   - In lasso selection: check bounding box intersection before testing polygon containment.
3. In `inkwell/crates/inkwell-core/src/doc.rs`:
   - Add `pub fn bbox(&self) -> [f64; 4]` on `Stroke` and pre-filter strokes in `erase_strokes_near` and `erase_strokes_in_rect`.

**Verify**: Run `cd inkwell; cargo test -- --test-threads=1` → all tests pass.

### Step 2: Virtualize the Page Thumbnail Drawer DOM

In `inkwell-app/src/js/app.js`:
1. In `renderThumbnails()`:
   - Compute total virtual scroll height (`pageCount * itemHeight`) on the thumbnail container.
   - Attach a scroll listener to `$('drawerThumbnails')`. On scroll (throttled via rAF), calculate the visible page range `[startIndex, endIndex]` (with 5 items buffer).
   - Render and mount only DOM cards within the visible range; reuse a single offscreen canvas for thumbnail bitmap generation.
   - Index strokes by sheet `strokesBySheet.get(sheetIndex)` so thumbnail rendering never scans the entire document stroke list.

**Verify**: Open `Higher_Math_Bangla_chapter_3.pdf` (multi-hundred pages) and toggle the thumbnail drawer: drawer opens in under 16ms without memory spikes.

## Test plan

- Test eraser on a dense document with 2,000+ strokes: erasing strokes must maintain steady 120 FPS.
- Test lasso selection on dense pages: bounding box selection must be instant.
- Test thumbnail scrolling in 500+ page documents: scrolling must remain fluid and memory usage bounded.

## Done criteria

- [ ] Stroke AABBs cached in JS and Rust
- [ ] Non-overlapping strokes rejected in O(1) during erase and selection
- [ ] Thumbnail drawer renders only visible viewport cards
- [ ] `cd inkwell; cargo test -- --test-threads=1` exits 0

## STOP conditions

- If stroke transformation (move/scale) fails to update `stroke.bbox`, ensure `updateStrokeBounds()` is called after transforms.

## Maintenance notes

- Any modification to stroke point samples must immediately invalidate and update the cached `bbox`.
