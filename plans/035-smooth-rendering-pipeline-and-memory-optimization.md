# Plan 035: Smooth Viewport RAF Pipeline & Memory Footprint Optimization

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell-app/src/js/viewport.js inkwell-app/src/js/app.js inkwell-app/src/js/ink.js inkwell-app/src-tauri/src/state.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf / smoothness
- **Planned at**: commit `8337e2c`, 2026-08-18

## Why this matters

Smooth 60/120 FPS rendering and zero pen lag are core requirements for digital handwriting. Currently, during high-velocity mouse wheel and trackpad zooming, multiple redundant RAF callbacks and tile re-requests can queue up, causing frame micro-stutters. Additionally, the backend `PageBitmapLruCache` and frontend `tileCache` hold raw RGBA buffers and `ImageBitmap` instances that can accumulate memory across large PDFs. Optimizing the wheel momentum physics loop, implementing strict sub-pixel velocity damping, and refining cache eviction keeps frame latency under 8ms and memory usage low.

## Current state

- `inkwell-app/src/js/viewport.js:302-333`: `wheelAccumX`/`wheelAccumY` executes in a simple RAF without kinetic momentum deceleration or sub-pixel damping.
- `inkwell-app/src/js/app.js:177-200`: `tileCache` evicts only when exceeding `TILE_CACHE_MAX = 200`, but does not proactively prune off-screen LOD tiles during fast scrolling.
- `inkwell-app/src-tauri/src/state.rs:23-59`: `PageBitmapLruCache` uses linear search over `Vec<CachedPageBitmap>` without memory byte budgeting.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Playwright Smoke Tests | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| E2E Test Suite | `cd e2e-tests; py -3 run_all.py` | exit 0, 272/272 pass |

## Scope

**In scope**:
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/js/app.js`
- `inkwell-app/src-tauri/src/state.rs`
- `inkwell-app/src-tauri/src/commands.rs`

## Git workflow

- Branch: `advisor/035-smooth-rendering-pipeline`
- Commit message: `perf(viewport): add kinetic momentum scrolling, adaptive LOD pruning, and LRU memory bounding`

## Steps

### Step 1: Add Kinetic Physics Momentum and Sub-Pixel Damping in `viewport.js`

1. In `ViewportManager`:
   - Implement inertial deceleration loop (`velocityX`, `velocityY`, `friction = 0.92`).
   - Clamp extreme wheel spikes and smooth discrete wheel notches for trackpad & high-res mice.
   - Decouple viewport matrix transformations from heavy canvas repaint triggers.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` -> exit 0.

### Step 2: Implement Adaptive LOD Tile Pruning & Bitmap Pool in `app.js`

1. When scrolling rapidly through multi-page documents:
   - Cancel outdated `render_tile` promises for tiles that have moved > 2 viewport heights off-screen.
   - Explicitly call `bitmap.close()` when evicting `ImageBitmap` to free GPU texture handles immediately.
   - Maintain a warm cache for LOD-0 overview thumbnails.

**Verify**: `cd e2e-tests; py -3 run_all.py` -> exit 0.

### Step 3: Bound Backend Bitmap Cache Memory in `state.rs`

1. Track approximate memory size in `PageBitmapLruCache` (e.g. max 128 MB) instead of a fixed entry count, ensuring small pages don't starve while large 4K sheets don't cause OOM.

**Verify**: `cd inkwell; cargo test` -> exit 0.

## Test plan

- Test continuous scrolling across a 100-page PDF: verify silky 60+ FPS motion without tile checkerboarding.
- Verify memory consumption remains stable after extensive panning and zooming.

## Done criteria

- [ ] Viewport motion feels fluid, physical, and responsive.
- [ ] No GPU texture memory leaks on `ImageBitmap` eviction.
- [ ] All tests pass.
