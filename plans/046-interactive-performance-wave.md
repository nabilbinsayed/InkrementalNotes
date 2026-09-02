# Plan 046: Interactive Performance Wave — Raw Tile Bytes, Pointer-Path Throttling, Redraw Culling

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: Written against working tree at `aef1b6a`.
> Confirm excerpts match; on mismatch STOP and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none hard; ideally after 045 (so the smoke suite guards each step)
- **Category**: perf
- **Decided tradeoffs honored**: JS-side tile grid stays (rejected Rust-side
  cache switch); wet/dry redraw discipline untouched; no stroke-smoothing
  micro-optimization (all per plans/README "rejected" list).

## Why this matters

Four hot paths do work per-event that scales badly and violates the repo's own
pointer-handler rule ("Never do work in the pointer handler", HANDOFF.md §5):
(1) every 1024px tile crosses IPC as a JSON array of ~4M numbers (~15 MB text,
50–150 ms parse) because `render_tile` returns `Vec<u8>` which serde renders
as a JSON list; (2) `resolvePressure` emits a diagnostics event with object
allocation on EVERY pressure sample (up to ~400/s), and its subscriber performs
~8 DOM lookups + writes per event; (3) `redrawAll` iterates ALL strokes for
every visible page on every pan/zoom frame with no bbox culling, and loaded
strokes tessellate lazily in one burst after open; (4) pinch-zoom and
scrollbar drag trigger duplicate synchronous full redraws on top of the
RAF-coalesced path.

## Current state

- `inkwell-app/src-tauri/src/commands.rs`:
  - `render_tile` (lines 489–494): `-> Result<Vec<u8>, String>`; line 626
    returns the cropped RGBA buffer. No use of `tauri::ipc::Response`
    anywhere in src-tauri (`rg "ipc::Response" inkwell-app/src-tauri/src` → 0).
- `inkwell-app/src/js/render/tiles.js` lines ~104–115: handles the result —
  has an `Array.isArray(rgbaData)` branch taking the slow
  `Uint8ClampedArray.from(array)` path, plus a length validation.
- `inkwell-app/src/js/tools/tool-manager.js` `resolvePressure` (lines 47–83):
  all three branches build an object literal and call
  `emit('hardwareDiagnostics', {...})`; line 51 allocates a template string.
- `inkwell-app/src/js/ui/drawers.js` lines ~38–69: subscribes to
  `hardwareDiagnostics` and does multiple `$('id')` lookups + textContent/
  className writes per event regardless of drawer visibility.
- `inkwell-app/src/js/render/compositor.js` `redrawAll` (lines 160–243):
  nested loop `for pane → for visiblePage → for ALL state.strokes filtered by
  sheet` (lines 224–230); text objects re-measure per frame and mutate
  `t.width/t.height` (lines 216–217).
- `inkwell-app/src/js/render/ink.js` lines ~352–399: Path2D built lazily in
  drawStroke when `_cachedPath2D` missing; chaikin subdivision allocates
  several objects per point.
- `inkwell-app/src/js/viewport.js` pinch branch (lines ~461–464): calls
  onChange AND `window.scheduleRedrawTiles()` AND `window.scheduleRedrawAll()`
  AND `window.redrawAll()` synchronously per pointermove.
- `inkwell-app/src/js/workspace/scrollbar.js` `onThumbMove` (~lines 57–65):
  calls setPan (→ scheduled redraws) then `compositor.redrawAll()` +
  `updateDocScrollbar` again synchronously; `updateDocScrollbar` reads
  `track.clientHeight` (forced layout) at line ~18.
- Loaded strokes arrive from `extract_frontend_strokes` WITHOUT a `bbox`
  field (commands.rs:155–182), so eraser AABB rejection (eraser.js:40) is
  skipped for them.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Backend check | `cd inkwell-app/src-tauri; cargo check` | exit 0 |
| Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |
| App smoke | `cd inkwell-app; py -3 test_app_smoke.py` | all pass |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs` (render_tile return type)
- `inkwell-app/src/js/render/tiles.js` (ArrayBuffer handling)
- `inkwell-app/src/js/tools/tool-manager.js` (throttle diagnostics)
- `inkwell-app/src/js/ui/drawers.js` (cache element refs; skip when hidden)
- `inkwell-app/src/js/render/compositor.js` (sheet index + bbox culling)
- `inkwell-app/src/js/core/document.js` (maintain the index on mutation)
- `inkwell-app/src/js/viewport.js` (remove duplicate redraw calls ONLY)
- `inkwell-app/src/js/workspace/scrollbar.js` (RAF-align updates)

**Out of scope** (do NOT touch):
- `render/ink.js` geometry/filter math (rejected-tradeoff zone).
- The wet/dry split semantics or pointer event routing in main.js.
- Backend tile caching strategy / pdfium threading (PERF-02) — separate
  follow-up; too risky to bundle here.
- Search-highlight culling in overlays.js (small; defer).

## Git workflow

- Branch: `advisor/046-interactive-performance-wave`
- Commit per step; style: `perf(ipc): raw tile bytes over IPC` etc.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Tiles cross IPC as raw bytes

Backend: change `render_tile` return type to
`Result<tauri::ipc::Response, String>` and return
`Ok(tauri::ipc::Response::new(rgba_data.into()))` (Vec<u8> → Bytes). Keep the
existing length-validation error path as `Err(String)`.

Frontend (`tiles.js`): replace the array branch — treat the resolved value as
an ArrayBuffer/Uint8Array:

```js
let bytes;
if (rgbaData instanceof ArrayBuffer) bytes = new Uint8ClampedArray(rgbaData);
else if (ArrayBuffer.isView(rgbaData)) bytes = new Uint8ClampedArray(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);
else if (Array.isArray(rgbaData)) bytes = Uint8ClampedArray.from(rgbaData); // legacy fallback
```

Keep the existing expected-length check. Keep the legacy array fallback so a
mid-upgrade mismatch degrades instead of breaking.

**Verify**: `cargo check` exit 0; `node --check tiles.js` exit 0; run app
manually → pages still render (operator check).

### Step 2: Throttle hardware diagnostics off the sample path

In `tool-manager.js`: make `resolvePressure` PURE — it must only compute and
return pressure and update module scalars. Remove all three
`emit('hardwareDiagnostics', ...)` calls. Add a rAF-gated notifier:

```js
let _diagPending = false;
function scheduleDiagnostics(pointerType, source, pressure) {
  if (_diagPending) return;
  _diagPending = true;
  requestAnimationFrame(() => {
    _diagPending = false;
    emit('hardwareDiagnostics', { device: activeStylusDevice, pointerType, pressureSource: source, pressure });
  });
}
```

Call it once per resolvePressure invocation (it coalesces to ≤ display rate).
Move the template-string device-info allocation out of the hot path: compute
`state.nativeDeviceInfo` once at handshake (already done there) and stop
recomputing per sample (delete line ~51's reassignment).

In `drawers.js`: hoist the diagnostic element lookups into module-level
lazily-initialized constants (resolve on first event), and early-return unless
the settings/diagnostics panel is currently visible (check the existing
drawer-state variable this file already maintains).

**Verify**: `node --check` both files; smoke suite green; operator: open
settings diagnostics while drawing → values still update live.

### Step 3: Sheet-indexed strokes with bbox culling in redrawAll

In `document.js`: maintain `state._strokesBySheet` (a plain
`Map<number, Stroke[]>`) updated inside `addStroke`, `deleteStrokes`,
`clearPageInk`, `setDocument`, and the undo/redo dispatches in the same file
(rebuild the map wholesale in `setDocument`; incrementally elsewhere; on undo/
redo of add/erase simply rebuild — correctness over cleverness). Export
`getStrokesForSheet(sheet)` returning the array (possibly empty).

In `compositor.js` `redrawAll`: replace the inner full-array scan with
`const sheetStrokes = documentOps.getStrokesForSheet(pl.sheet);` then iterate
that; skip strokes whose `s.bbox` exists and lies entirely outside the page
rect (page rect IS the clip domain here since drawing is page-local — cull
against `[0, 0, pl.width, pl.height]` expanded by base_width).

Also fix the render-mutates-state wart: move the `t.width/t.height` assignment
for text objects out of redrawAll into `upsertTextObject` (document.js) using
a one-off measure canvas; compositor reads but never writes.

**Verify**: `node --check` both files; smoke suite green; operator: pan/zoom
a 100+ stroke document — no visual regressions, eraser still works (eraser
keeps its own scan; unchanged).

### Step 4: Remove duplicate synchronous redraws

In `viewport.js` pinch branch: delete the explicit
`window.scheduleRedrawTiles()/scheduleRedrawAll()/redrawAll()` calls (keep
`onChange`, keep `updateZoomUI/updateDocScrollbar` guarded calls — those are
not duplicated by onChange... verify: main.js onChange callback DOES call
`scrollbar.updateDocScrollbar`; therefore delete those two guarded calls too).
In `scrollbar.js` `onThumbMove`: delete the trailing direct
`compositor.redrawAll()` and `updateDocScrollbar(viewport)` calls (setPan's
onChange already schedules both via main.js).

**Verify**: `node --check` both; operator: pinch-zoom and scrollbar drag feel
unchanged (they will be smoother); no stuck frames after gesture ends (the
pending-flag pattern guarantees a final paint).

### Step 5: Prefetch-loaded-stroke tessellation (cheap version)

In `main.js` `handlePdfLoadResult`, after `documentOps.setDocument(...)`,
schedule idle-time Path2D warmup:

```js
const warm = () => {
  const t0 = performance.now();
  for (const s of state.strokes) {
    if (!s.deleted && !s._cachedPath2D && window.Ink?.getPath2D) {
      s._cachedPath2D = window.Ink.getPath2D(s);
      s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
      if (performance.now() - t0 > 8) { setTimeout(warm, 32); return; }
    }
  }
};
setTimeout(warm, 200);
```

This also gives every loaded stroke a `bbox`, enabling the eraser AABB path
and Step-3 culling for pre-existing documents.

**Verify**: `node --check main.js`; smoke suite green; operator: open a large
annotated PDF → first pan no longer hitches.

### Step 6: Battery

**Verify**: `cd inkwell; cargo clippy --all-targets` → zero warnings;
`cd inkwell-app/src-tauri; cargo check` → exit 0;
`cd inkwell-app; py -3 test_app_smoke.py` → all pass.

## Test plan

- Smoke suite must remain green after EVERY step (run it per step).
- Manual operator measurements to record in the PR: with devtools Performance
  panel, record a 5 s pan across a tiled PDF before/after Step 1 (expect the
  long JSON.parse tasks gone), and a 5 s scribble with settings open before/
  after Step 2 (expect DOM task count per second to drop sharply).

## Done criteria

ALL must hold:
- [ ] `rg -n "Result<Vec<u8>, String>" inkwell-app/src-tauri/src/commands.rs` → 0 matches near render_tile
- [ ] `rg -n "emit\('hardwareDiagnostics'" inkwell-app/src/js/tools/tool-manager.js` → only inside scheduleDiagnostics
- [ ] `rg -n "window.redrawAll\(\)" inkwell-app/src/js/viewport.js` → 0 matches
- [ ] `getStrokesForSheet` exists and is used by compositor (`rg -n "getStrokesForSheet" inkwell-app/src/js`)
- [ ] Smoke suite green; clippy zero warnings
- [ ] No files outside scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- `tauri::ipc::Response` is unavailable in the pinned tauri v2 feature set
  (needs the `ipc` feature?) — report the exact compiler guidance; do NOT add
  features without reporting.
- The frontend receives something other than ArrayBuffer/array from the stubbed
  invoke in tests (shape contract changed upstream).
- Removing the duplicate redraw calls causes visible tearing or stale frames
  (means some path bypassed onChange) — restore, report which tool exposed it.
- Maintaining `_strokesBySheet` in document.js would require touching files
  outside scope (mutation sites moved since audit).

## Maintenance notes

- PERF-02 (pdfium re-parse under mutex on cold tile miss) is deliberately
  deferred: it needs a dedicated pdfium worker thread design. File it as the
  next perf plan if pan-latency remains an issue after this wave.
- If tabs/multi-session return, `_strokesBySheet` must become per-document.
- Reviewer focus: Step 1's legacy array fallback removal timing, and that
  Step 3's incremental map updates cover EVERY mutation site (grep
  `state.strokes` assignments).
