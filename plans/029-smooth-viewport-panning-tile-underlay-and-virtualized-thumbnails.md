# Plan 029: Frictionless Viewport Physics: RAF Wheel Decoupling, Progressive LOD-0 Underlay, and Virtualized Thumbnails

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell-app/src/js/viewport.js inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/027-page-lifecycle-layout-sync-and-insertion-dialog.md
- **Category**: perf
- **Planned at**: commit `8337e2c`, 2026-08-17

## Why this matters

Navigating, scrolling, and zooming within documents must feel silky smooth (120Hz/60Hz) without perceptible stutter, frame drops, or visual flashing. Currently, mouse wheel and trackpad scroll events execute direct synchronous pan updates and matrix recalculations on every raw event, overwhelming the main thread during fast trackpad gestures. Additionally, fast scrolling causes dark unrasterized tile holes to briefly appear before asynchronous worker tasks return. In the thumbnail drawer, scrolling triggers a full DOM wipe and rewrite of `grid.innerHTML` on every tick, causing micro-stutter and memory thrashing.

## Current state

- `inkwell-app/src/js/viewport.js:273-291`: Wheel listener updates `this.panX`/`this.panY` directly and executes synchronous `this.onChange()`, causing redundant canvas clears.
- `inkwell-app/src/js/app.js:315-337`: `redrawTiles()` clears tile regions directly; unrendered tiles show a bare background without a coarse low-resolution preview underlay.
- `inkwell-app/src/js/app.js:3373-3380`: `renderThumbnails()` sets `grid.innerHTML = cardsHtml.join('')` and rebinds all event listeners on every scroll event in the thumbnail drawer.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |

## Scope

**In scope** (the only files you should modify):
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/js/app.js`

**Out of scope** (do NOT touch):
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-core`

## Git workflow

- Branch: `advisor/029-smooth-viewport-physics`
- Commit message: `perf(viewport): decouple wheel events with RAF physics, add tile underlay and virtualize thumbnails`

## Steps

### Step 1: Decouple Wheel and Trackpad Pan/Zoom via RAF Physics Loop in `viewport.js`

In `inkwell-app/src/js/viewport.js`:
1. In `attachListeners()`, collect delta offsets in an accumulator (`this.pendingDeltaX`, `this.pendingDeltaY`, `this.pendingZoom`).
2. Dispatch viewport pan/zoom updates on `requestAnimationFrame` using an inertial velocity decay curve ($v_{t+1} = v_t \times 0.92$) when wheel gestures finish.
3. Prevent layout thrashing by updating `this.panX`/`this.panY` once per display refresh tick before scheduling canvas redraws.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0

### Step 2: Progressive LOD-0 Page Thumbnail Underlay in `app.js`

In `inkwell-app/src/js/app.js`:
1. Store a coarse (256px) full-page thumbnail bitmap for each loaded page in a global `lod0Cache` map.
2. In `redrawTilesForPage()`, before requesting or awaiting high-resolution sub-tiles (512/1024/2048px), blit the scaled LOD-0 thumbnail onto the page area.
3. When high-resolution tiles arrive from worker threads, draw them seamlessly over the LOD-0 backdrop without clearing or flashing black rectangles.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0, 18/18 checks pass

### Step 3: DOM Element Pooling and Card Recycling for Thumbnail Drawer in `app.js`

In `inkwell-app/src/js/app.js`:
1. Refactor `updateVisibleThumbnails()` in `renderThumbnails()`:
   - Create a pool of reusable DOM `.thumb-card` elements matching the maximum visible capacity (~12 cards).
   - Update their `style.top`, `data-page`, page number label, and canvas bitmap contents dynamically as the drawer scrolls.
   - Do NOT clear `grid.innerHTML` on scroll.
2. Bind persistent click delegation on `#thumbnailGrid` instead of attaching listeners to every individual card on every scroll tick.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0

## Test plan

- Test fast trackpad scrolling on a 100+ page PDF; verify frame rate stays smooth (>55 FPS) with zero blank tile flicker.
- Test pinch-to-zoom and wheel zoom; verify zooming scales smoothly centered at the mouse pointer without jumpiness.
- Scroll through the thumbnail drawer rapidly and monitor DOM node count; verify node count remains constant (~12 cards).

## Done criteria

- [ ] Wheel scrolling uses RAF decoupling with smooth sub-pixel velocity decay
- [ ] Progressive LOD-0 underlay eliminates dark tile flashing during rapid navigation
- [ ] Thumbnail drawer pools DOM cards and avoids full `innerHTML` repaints on scroll
- [ ] Smoke tests and core tests pass cleanly

## STOP conditions

- If wheel delta accumulation causes perceived scroll lag on high-DPI mice, reduce velocity smoothing window.
- If LOD-0 thumbnail blitting distorts aspect ratios, ensure bounding rects match `pl.width` and `pl.height`.

## Maintenance notes

- Any future zoom modes (e.g. continuous horizontal scroll) should route through this RAF physics loop.
