# Plan 038: Complete Modular ES Frontend Cutover, Feature Porting & `app.js` Decommissioning

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aef1b6a..HEAD -- inkwell-app/src/index.html inkwell-app/src/js/main.js inkwell-app/src/js/core/ inkwell-app/src/js/ui/ inkwell-app/src/js/tools/ inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/037-text-selection-accuracy.md
- **Category**: tech-debt
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

InkWell's frontend currently maintains two divergent codebases: a 7,878-line monolithic script (`inkwell-app/src/js/app.js`) loaded by `index.html`, and a modern modular ES module architecture under `inkwell-app/src/js/` (`main.js`, `core/`, `render/`, `tools/`, `ui/`, `workspace/`). Recent crucial features — such as native Linux `evdev` stylus streaming, live hardware diagnostics UI, chisel highlighter math, multi-touch gestures, and autosave badges — were implemented directly in `app.js` while modular files drifted. This plan ports all missing logic into the modular subsystem, switches `index.html` to `<script type="module" src="js/main.js"></script>`, and permanently deletes `app.js`.

## Current state

- `inkwell-app/src/index.html`:
  Loads legacy scripts at the bottom:
  ```html
  <script src="js/ink.js"></script>
  <script src="js/viewport.js"></script>
  <script src="js/app.js"></script>
  ```
- `inkwell-app/src/js/app.js`:
  Contains the active implementation of `initNativeStylusStream()`, `resolvePressure(e)`, `updateHardwareDiagnostics()`, multi-touch pinch-zoom / pan tracking, paper template background selection modals, and page management suite.
- `inkwell-app/src/js/main.js` & modular subsystems:
  Provide the clean modular structure but lack the evdev stylus channel, hardware diagnostics UI binding, and complete modal bindings.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| JS Syntax Check | `Get-ChildItem -Recurse -Filter *.js inkwell-app/src/js \| ForEach-Object { node -c $_.FullName }` | exit 0, no errors |
| Playwright Smoke | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |

## Scope

**In scope**:
- `inkwell-app/src/index.html`
- `inkwell-app/src/js/main.js`
- `inkwell-app/src/js/core/ipc.js`
- `inkwell-app/src/js/core/state.js`
- `inkwell-app/src/js/tools/pen.js`
- `inkwell-app/src/js/tools/tool-manager.js`
- `inkwell-app/src/js/ui/drawers.js`
- `inkwell-app/src/js/ui/toolbar.js`
- `inkwell-app/src/js/workspace/navigation.js`
- `inkwell-app/src/js/app.js` (DELETE)

**Out of scope**:
- Rewriting `viewport.js` or `ink.js` math kernels (they are imported cleanly by the compositor and tools).
- Backend Rust changes.

## Git workflow

- Branch: `advisor/038-modular-frontend-migration`
- Commit style: `refactor(frontend): <description>`

## Steps

### Step 1: Port Native Linux Evdev Stylus Stream and Pressure Resolver to Modular Core
1. In `inkwell-app/src/js/core/ipc.js`:
   - Export `initNativeStylusStream(onHandshake, onSample)` utilizing Tauri's `Channel` and `start_stylus_stream` command.
2. In `inkwell-app/src/js/tools/tool-manager.js` (or `tools/pen.js`):
   - Implement and export `resolvePressure(e)` using the live native sample stream with browser PointerEvent fallback.
   - Dispatch hardware diagnostics state updates to UI listeners.
3. In `inkwell-app/src/js/ui/drawers.js` (Settings Tab):
   - Wire hardware diagnostics elements (`diagActiveDevice`, `diagPointerType`, `diagPressureSource`, `diagLivePressure`, `diagSampleAge`).

**Verify**: `node -c inkwell-app/src/js/tools/tool-manager.js` → exit 0

### Step 2: Port Page Management Suite & Paper Template Modals to Modular UI
1. In `inkwell-app/src/js/ui/drawers.js` and `ui/toolbar.js`:
   - Wire Insert Page dialog (page index, orientation, template pattern: blank, grid, ruled, dots, cornell).
   - Wire Page Duplicate, Delete Page, and Page Reorder buttons with confirmation toasts.
   - Ensure backend mutations invoke `ipc.insertBlankPage`, `ipc.deletePage`, and `ipc.reorderPages`.

**Verify**: `node -c inkwell-app/src/js/ui/drawers.js` → exit 0

### Step 3: Wire Multi-Touch Pinch Zoom and Gesture Pacing
1. In `inkwell-app/src/js/main.js`:
   - Track active pointer cache `activePointers: Map<id, {x, y}>`.
   - When 2 pointers are active, compute pinch distance and midpoint to drive `_viewport.zoomAt(midX, midY, factor)` and smooth pan.
   - Integrate palm rejection threshold: ignore touch inputs within 120ms of a pen contact.

**Verify**: `node -c inkwell-app/src/js/main.js` → exit 0

### Step 4: Switch `index.html` to ES Module and Remove `app.js`
1. In `inkwell-app/src/index.html`:
   - Replace `<script src="js/app.js"></script>` with:
     ```html
     <script type="module" src="js/main.js"></script>
     ```
2. Delete the obsolete 7,878-line file `inkwell-app/src/js/app.js`.

**Verify**:
- `git status` shows `inkwell-app/src/js/app.js` deleted.
- Run `node -c inkwell-app/src/js/main.js` → exit 0.

## Test plan

- Verify all buttons in navigation rail (Thumbnails, Outline, Search, Bookmarks, Layers, Settings) open correct drawers.
- Verify Pen, Highlighter, Eraser, Lasso, Text, Shape, and TextSelect tools activate and draw smoothly.
- Verify hardware diagnostics badge updates live on pointer input.

## Done criteria

- [ ] `index.html` loads only `js/ink.js`, `js/viewport.js`, and `<script type="module" src="js/main.js"></script>`.
- [ ] `inkwell-app/src/js/app.js` is completely removed from the repository.
- [ ] All JS files pass syntax validation (`node -c`).
- [ ] No `ReferenceError` or missing symbol errors occur in browser runtime.
- [ ] `plans/README.md` status row updated to DONE.

## STOP conditions

- If any DOM element ID referenced in `main.js` or `ui/` does not exist in `index.html`, stop and verify `index.html` markup.
- If ES module imports fail under Tauri v2 WebView2/WebKit origin policies, stop and verify relative import paths.

## Maintenance notes

- All future frontend features must be added into dedicated modular files (`tools/`, `ui/`, `core/`, `workspace/`) and registered in `main.js`. Never create single-file monolithic catch-alls.
