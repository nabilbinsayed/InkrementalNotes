# Plan 042: Restore Working Zoom Controls — Methods, Presets, Live Display & Shortcuts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: Written against working tree at `aef1b6a` with
> uncommitted Plan-038 cutover changes. Confirm each excerpt below still
> matches the live file; on mismatch, STOP and report.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent of 041)
- **Category**: bug
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

Every zoom entry point that is not Ctrl+wheel is broken: the floating zoom
In/Out buttons throw `TypeError: _viewport.zoomIn is not a function`, the zoom
preset menu computes `NaN` pan coordinates that can corrupt viewport state, the
zoom percentage readout is permanently frozen at "100%", and the keyboard
shortcuts advertised in the Shortcuts modal (`Ctrl++`, `Ctrl+-`, `Ctrl+0`) have
no registered commands. This is one of the user-reported breakages.

## Current state

- `inkwell-app/src/js/viewport.js` — defines class `ViewportManager`
  (lines 7–516) with public methods: `setZoom(z, centerPx, pane)` (line 215),
  `fitPage(pageWidthPt, pageHeightPt, pane)` (line 261), `fitWidth(...)`
  (line 277), `screenToWorld`, `worldToScreen`, etc. It has **no** `zoomIn`,
  `zoomOut`, `stageW`, or `stageH` members. It stores geometry in
  `this.stageRect` (a DOMRect) set by `updateStageRect()` (line 35).
- `inkwell-app/src/js/ui/toolbar.js`:
  - Lines 266–278:
    ```js
    $('btnZoomIn') && $('btnZoomIn').addEventListener('click', () => {
      if (_viewport) {
        _viewport.zoomIn();            // <-- method does not exist
        emit('zoomChanged', { zoom: _viewport.zoom });
      }
    });
    $('btnZoomOut') && $('btnZoomOut').addEventListener('click', () => {
      if (_viewport) {
        _viewport.zoomOut();           // <-- method does not exist
        emit('zoomChanged', { zoom: _viewport.zoom });
      }
    });
    ```
  - Line 309 (zoom preset menu items):
    ```js
    _viewport.setZoom(factor, [_viewport.stageW / 2, _viewport.stageH / 2], 'left');
    ```
    `stageW`/`stageH` are undefined → center `[NaN, NaN]` → `setZoom` computes
    NaN pans and clamps them to NaN.
- `inkwell-app/src/index.html` line 461: `<span id="zoomLevelDisplay">100%</span>`
  — no JS anywhere writes to it (`rg zoomLevelDisplay inkwell-app/src/js`
  returns nothing). The buttons live at lines 457–476
  (`btnZoomOut`, `btnZoomMenu`, `btnZoomIn`, `btnZoomFit`, `btnZoomSplit`).
- `inkwell-app/src/index.html` lines 963–966 (Shortcuts modal) advertise:
  `Zoom In / Out — Ctrl++ / Ctrl+-` and `Fit Page to Window — Ctrl+0`.
- `inkwell-app/src/js/core/commands.js` — tiny command registry with
  `register({id, title, category, shortcut, execute})` and
  `findMatchingShortcut(e)` which normalises key events to strings like
  `"Ctrl+S"` (read lines 30–94 before editing).
- `inkwell-app/src/js/main.js` — `registerCoreCommands()` (lines 110–318) is
  where all commands are registered; `_viewport` module variable holds the
  ViewportManager instance.
- Convention exemplar for a command registration: `main.js:287-300`
  (`view.toggleSplit`). For UI-state emission: `state.js` `emit/on`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| JS syntax check | `node --check inkwell-app/src/js/ui/toolbar.js` (and each edited file) | exit 0 |
| App smoke | `cd inkwell-app; py -3 test_app_smoke.py` | 8/8 pass |

## Scope

**In scope**:
- `inkwell-app/src/js/viewport.js` (add methods only)
- `inkwell-app/src/js/ui/toolbar.js` (fix call sites)
- `inkwell-app/src/js/main.js` (register commands)
- `inkwell-app/src/js/workspace/scrollbar.js` ONLY if needed for nothing — it is NOT in scope; listed here to say: do not touch.

Actually restrict edits to exactly these three files:
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/js/ui/toolbar.js`
- `inkwell-app/src/js/main.js`

**Out of scope** (do NOT touch):
- `index.html` — the buttons and modal already exist; no markup changes needed.
- `styles.css`.
- Pinch-zoom / wheel logic in `viewport.js` `attachListeners` — it works;
  do not refactor it.
- Text selection, sticky notes, search (Plan 043).

## Git workflow

- Branch: `advisor/042-zoom-controls-repair`
- Commit per step; style: `fix(ui): repair zoom buttons, presets, display and shortcuts`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the missing viewport methods

In `viewport.js` inside class `ViewportManager` (place them right after
`setZoom`, around line 245), add:

```js
zoomIn(centerPx = null, pane = 'left') {
  const cur = (pane === 'right' && this.splitMode) ? this.rightZoom : this.zoom;
  this.setZoom(Math.min(10.0, cur * 1.25), centerPx, pane);
}

zoomOut(centerPx = null, pane = 'left') {
  const cur = (pane === 'right' && this.splitMode) ? this.rightZoom : this.zoom;
  this.setZoom(Math.max(0.15, cur / 1.25), centerPx, pane);
}

get stageW() { return this.stageRect ? this.stageRect.width : 800; }
get stageH() { return this.stageRect ? this.stageRect.height : 600; }
```

The 1.25 factor and clamps mirror the existing wheel-zoom bounds in
`attachListeners` (lines 357, 221).

**Verify**: `node --check inkwell-app/src/js/viewport.js` → exit 0.

### Step 2: Fix the toolbar call sites

In `toolbar.js`:
- Replace `_viewport.zoomIn();` with
  `_viewport.zoomIn([_viewport.stageW / 2, _viewport.stageH / 2], 'left');`
- Replace `_viewport.zoomOut();` with
  `_viewport.zoomOut([_viewport.stageW / 2, _viewport.stageH / 2], 'left');`
- Line ~309 already reads `_viewport.stageW / 2, _viewport.stageH / 2` — after
  Step 1 those getters exist and return numbers; no change needed there, but
  confirm the preset branch passes `'left'` pane (it does).

**Verify**: `node --check inkwell-app/src/js/ui/toolbar.js` → exit 0.

### Step 3: Make the zoom readout live

In `main.js` inside the passive state listeners block (after the existing
`on('pageChanged', ...)` registration near line 665), add:

```js
on('zoomChanged', payload => {
  const el = $('zoomLevelDisplay');
  if (el && payload && typeof payload.zoom === 'number') {
    el.textContent = Math.round(payload.zoom * 100) + '%';
  }
});
```

Then make every zoom mutation path emit the event. The cleanest single point:
in `viewport.js`, at the end of `setZoom` (and in the pinch handler where zoom
is set directly, lines ~452–460), after `if (this.onChange) this.onChange();`
add:

```js
if (typeof window !== 'undefined' && typeof window.emitZoomChanged === 'function') {
  window.emitZoomChanged(this);
}
```

and in `main.js` bootstrap (near the other `window.*` bridges at the end of
`DOMContentLoaded`, lines 674–679) add:

```js
window.emitZoomChanged = (vp) => {
  const z = vp.splitMode && vp.activePane === 'right' ? vp.rightZoom : vp.zoom;
  emit('zoomChanged', { zoom: z });
};
```

Call `window.emitZoomChanged(_viewport)` once at the end of
`handlePdfLoadResult` so the display initializes to the fitted zoom instead of
stale "100%".

Note: viewport.js must stay a classic script (it is loaded via `<script src>`
before the ES module); using the `window.emitZoomChanged` bridge keeps the
dependency direction correct (module wires the bridge; classic script calls it
defensively).

**Verify**: `node --check inkwell-app/src/js/main.js` and
`node --check inkwell-app/src/js/viewport.js` → exit 0.

### Step 4: Register the advertised keyboard shortcuts

In `main.js` `registerCoreCommands()`, after the view commands block (~line
308), add three registrations following the exact pattern of
`view.toggleSplit`:

```js
reg.register({
  id: 'view.zoomIn', title: 'Zoom In', category: 'View', shortcut: ['Ctrl+=', 'Ctrl++'],
  execute: () => { if (_viewport) { _viewport.zoomIn([_viewport.stageW / 2, _viewport.stageH / 2], 'left'); window.emitZoomChanged(_viewport); } },
});
reg.register({
  id: 'view.zoomOut', title: 'Zoom Out', category: 'View', shortcut: 'Ctrl+-',
  execute: () => { if (_viewport) { _viewport.zoomOut([_viewport.stageW / 2, _viewport.stageH / 2], 'left'); window.emitZoomChanged(_viewport); } },
});
reg.register({
  id: 'view.fitPage', title: 'Fit Page to Window', category: 'View', shortcut: 'Ctrl+0',
  execute: () => {
    if (_viewport && state.pageInfos && state.pageInfos[0]) {
      _viewport.fitPage(state.pageInfos[0].width_pt, state.pageInfos[0].height_pt, 'left');
      window.emitZoomChanged(_viewport);
    }
  },
});
```

Before finalizing, READ `core/commands.js` `findMatchingShortcut` and confirm
how `"Ctrl+="` normalises against `e.key === '='` with ctrlKey true (browsers
report `Ctrl++` as key `=` with shift on some layouts). If the normaliser
cannot produce `Ctrl+=`, adjust the registered shortcut strings to whatever
the normaliser actually emits — do NOT modify the normaliser's behaviour for
existing shortcuts.

**Verify**: `node --check inkwell-app/src/js/main.js` → exit 0.

### Step 5: Full battery

**Verify**: `cd inkwell-app; py -3 test_app_smoke.py` → 8/8 pass (boot must
stay clean; the suite asserts zero console errors, which also proves the old
TypeError path is gone IF the suite clicked zoom — it does not yet; that test
gap is Plan 045's scope. Your verification here is `node --check` plus manual
click-through below).

Manual click-through for the operator (record in PR description):
1. Launch app, open any PDF → click `btnZoomIn` 3× → page grows, % readout
   updates, no console errors.
2. Click `btnZoomOut` 3× → shrinks back.
3. Open zoom preset menu → pick 200% → centers at 200%, readout "200%".
4. Press Ctrl+0 → fit-page zoom, readout updates.

## Test plan

No repo JS test runner exists yet (Plan 045 introduces it). For now:
- Structural check: `rg -n "zoomIn\(\)|zoomOut\(\)" inkwell-app/src/js/ui/toolbar.js` → no bare zero-arg calls remain.
- The smoke suite must stay green.

## Done criteria

ALL must hold:
- [ ] `node --check` passes on all three edited files
- [ ] `py -3 test_app_smoke.py` → 8/8
- [ ] `rg -n "_viewport.zoomIn\(\)" inkwell-app/src/js` → no matches
- [ ] `rg -n "zoomLevelDisplay" inkwell-app/src/js/main.js` → ≥1 match (listener wired)
- [ ] `rg -n "view.zoomIn|view.zoomOut|view.fitPage" inkwell-app/src/js/main.js` → 3 matches
- [ ] No files outside the three in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- `ViewportManager` in the live tree already has `zoomIn`/`zoomOut` (drift —
  someone fixed it differently).
- `commands.js` `findMatchingShortcut` cannot represent `Ctrl+0` / `Ctrl+-`
  without semantic changes to its normalisation (report what you found).
- Adding the getters conflicts with an existing `stageW` assignment somewhere
  (`rg -n "\.stageW\s*=" inkwell-app/src/js` — if any code ASSIGNS stageW,
  report; getters would break it).

## Maintenance notes

- Future viewport work should treat `setZoom`/`fitPage` as the only mutation
  points; if a new direct-zoom site appears (like the pinch handler), it must
  call `window.emitZoomChanged` too or the readout goes stale again.
- Reviewer focus: confirm the pinch handler emits zoom changes (Step 3) and
  that no `onChange` semantics changed for tile scheduling.
