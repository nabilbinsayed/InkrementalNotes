# Plan 020: Zero-Latency Inking Pipeline, DOM Layout Thrashing Elimination, and Path2D Retention

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1154947..HEAD -- inkwell-app/src/js/app.js inkwell-app/src/js/ink.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `1154947`, 2026-08-14

## Why this matters

During 120Hz–240Hz stylus digitizer drawing, `consume(e)` in `app.js` currently invokes `updateStats` and queries `getBoundingClientRect()` on every single pointer sample. This causes continuous forced synchronous DOM reflows (layout thrashing) and allocates intermediate strings and filtered arrays on the critical rendering path. Eliminating these allocations and layout queries reduces pen-tip-to-photon latency to under 1ms, preventing dropped samples and ensuring an absolutely smooth, fluid inking feel.

## Current state

- `inkwell-app/src/js/app.js:775-790` — `consume(e)` recalculates `fillStyle` with `.map().join(',')`, calls `Ink.drawSegment`, and runs `updateStats(e.pointerType)` per sample.
- `inkwell-app/src/js/app.js:2153-2159` — `updateStats()` executes `$('inputStats').innerHTML = ...` and filters all document strokes `state.strokes.filter(s => !s.deleted).length` per point.
- `inkwell-app/src/js/app.js:546` & `144` — `localXY(e)` and `paneForEvent(e)` invoke `wetCanvas.getBoundingClientRect()` synchronously on every pointer move.
- `inkwell-app/src/js/ink.js:98` — `Stroke.push` formats floats with `toFixed()` strings and parses them with unary `+`.
- `inkwell-app/src/js/app.js:2140` — `onUp` executes `clearWet()` which clears the full viewport canvas instead of only the active stroke bounding box.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test -- --test-threads=1` | exit 0, all 48 tests pass |
| Clippy | `cd inkwell-app/src-tauri; cargo clippy --all-targets` | exit 0, zero warnings |

## Scope

**In scope**:
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/js/ink.js`

**Out of scope**:
- Rust `inkwell-core` geometry math (`ink.rs`) — already verified and performant.
- Viewport coordinate transformation math in `viewport.js`.

## Git workflow

- Branch: `advisor/020-pen-latency-optimization`
- Commit per step; message style: `perf(ink): <description>`

## Steps

### Step 1: Remove `updateStats` and per-sample DOM mutations from the inking loop

In `inkwell-app/src/js/app.js`:
1. Remove `updateStats(e.pointerType)` from `consume(e)` (line 789).
2. Schedule `updateStats` to run at most once on `onUp` (or throttle via a low-frequency timer), and guard `const el = $('inputStats'); if (el) { ... }` so it never throws a null property error.
3. Cache `stageRect` updates during window resize, drawer transitions, and scroll events; avoid calling `getBoundingClientRect()` inside `localXY` or `paneForEvent` when cached `stageRect` is valid.

**Verify**: Run `cd inkwell-m0; py -3 test_smoke.py` → all checks pass.

### Step 2: Precompute CSS color strings and eliminate number-to-string allocations in `ink.js`

1. In `inkwell-app/src/js/ink.js` in `Stroke` constructor, precompute `this.cssColor = \`rgb(${this.rgb.map(v => Math.round(v * 255)).join(',')})\`;`.
2. In `Stroke.push` (`ink.js:98`), store numerical samples directly `this.samples.push([fx, fy, this._p, tMs]);` without `.toFixed()` conversions.
3. In `inkwell-app/src/js/app.js` in `consume(e)` (line 781), replace the dynamic template string with `wctx.fillStyle = state.cur.cssColor;`.
4. In `inkwell-app/src/js/ink.js` in `drawStroke` (line 360), use `stroke.cssColor || ...` to avoid string concatenation on redrawing.

**Verify**: Inspect `ink.js` and `app.js` to ensure no `toFixed` or `.join(',')` calls exist in the `push` / `consume` / `drawStroke` functions.

### Step 3: Retain `_cachedPath2D` and clear dirty bounding boxes on pen-up

1. In `inkwell-app/src/js/app.js` in `onUp(e)`:
   - When finalizing `state.cur`, eagerly generate and cache `finishedStroke._cachedPath2D = Ink.getPath2D(finishedStroke);`.
   - Calculate the stroke's bounding box `[minX - pad, minY - pad, maxX + pad, maxY + pad]` and clear only the dirty rect on `wetCanvas` (`wctx.clearRect(...)`) or call `clearWet()` if transformed.
2. In `inkwell-app/src/js/ink.js` in `drawStroke`:
   - Fast-path `if (stroke._cachedPath2D) { ctx.fill(stroke._cachedPath2D); return; }` to bypass polyline subdivision during document redraws.

**Verify**: Run `cd inkwell-m0; py -3 test_smoke.py` → all checks pass.

## Test plan

- Test continuous stylus drawing on canvas: drawing 1,000 points must not cause layout reflows or console errors.
- Test stroke redrawing performance: panning and zooming documents with 500+ strokes must maintain 60–120 FPS.
- Verify stroke color rendering matches expected RGB values for Pen and Highlighter.

## Done criteria

- [ ] Zero calls to `getBoundingClientRect` or `updateStats` inside `consume()`
- [ ] No `toFixed` string parsing in `Stroke.push`
- [ ] `cd inkwell-m0; py -3 test_smoke.py` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- If `stageRect` caching causes offset coordinate drift on high-DPI scaling changes, re-evaluate stage resize observer listeners.
- If `py -3 test_smoke.py` fails on canvas drawing assertions.

## Maintenance notes

- Any future UI HUD counters or telemetry metrics must be scheduled via decoupled timers (e.g. 500ms intervals) and never wired directly into pointer event handlers.
