# Plan 032: Configurable Autosave After Delay & Non-Blocking Dirty State Engine

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell-app/src/js/app.js inkwell-app/src/index.html inkwell-app/src/styles.css inkwell/crates/inkwell-core/src/wal.rs inkwell-app/src-tauri/src/commands.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/028-multi-document-tab-backend-session-sync.md
- **Category**: bug / feature
- **Planned at**: commit `8337e2c`, 2026-08-18

## Why this matters

Currently, Inkwell only saves documents when the user explicitly triggers a manual save via `Ctrl+S` or the Save button. If a user works for hours without manually saving and encounters a system crash or power outage, unpersisted changes must rely exclusively on WAL journal replay. Furthermore, `inkwell-core/src/wal.rs` defines a `FlushPolicy` struct with idle detection, but this is never connected to the frontend or Tauri IPC. Implementing a debounced, configurable after-delay autosave system with non-blocking background execution and subtle status indicators ensures that users never lose work while preserving pen stroke smoothness without UI stutter or sync-folder thrashing.

## Current state

- `inkwell-app/src/js/app.js:5470-5534`: `saveDocument(forceSaveAs)` exists for manual invocation, but there is no background debounced timer, no dirty flag tracking (`isDirty`), and no user preference setting for autosave delay.
- `inkwell/crates/inkwell-core/src/wal.rs:197-255`: `FlushPolicy` defines `idle_secs` and `max_interval_secs`, but is unused.
- `inkwell-app/src/index.html`: Lacks an autosave delay selector in Settings / Quick Menu and lacks an animated save status indicator.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Playwright Smoke Tests | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |
| E2E Test Suite | `cd e2e-tests; py -3 run_all.py` | exit 0, 272/272 pass |

## Scope

**In scope** (the only files you should modify):
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`
- `inkwell-app/src-tauri/src/commands.rs`

**Out of scope** (do NOT touch):
- `inkwell/crates/inkwell-pdf`
- `inkwell/crates/inkwell-core/src/pdf.rs`

## Git workflow

- Branch: `advisor/032-autosave-after-delay`
- Commit message: `feat(save): add configurable after-delay autosave engine and status indicator`

## Steps

### Step 1: Add Dirty State Tracking and Autosave State Engine in `app.js`

1. In `state` object in `app.js`, add:
   ```javascript
   autosaveEnabled: localStorage.getItem('inkwell_autosave_enabled') !== 'false',
   autosaveDelayMs: parseInt(localStorage.getItem('inkwell_autosave_delay_ms') || '2000', 10), // default 2s (options: 500, 1000, 2000, 5000, 10000, 30000, 0=off)
   isDirty: false,
   isSaving: false,
   autosaveTimer: null,
   lastSaveTime: Date.now(),
   ```
2. Create helper `markDirty()`:
   ```javascript
   function markDirty() {
     state.isDirty = true;
     updateSaveStatusBadge('unsaved');
     triggerAutosaveDebounced();
   }
   ```
3. Create `triggerAutosaveDebounced()`:
   - Clear existing `state.autosaveTimer`.
   - If `!state.autosaveEnabled || state.autosaveDelayMs <= 0` return.
   - Set timer for `state.autosaveDelayMs`:
     ```javascript
     state.autosaveTimer = setTimeout(async () => {
       // Only autosave if dirty, not currently saving, not actively drawing, and tab has a valid path
       if (!state.isDirty || state.isSaving || state.cur || (viewport && viewport.isPanning)) return;
       const curTab = getCurrentTab();
       if (!curTab || !curTab.pathStr) return; // don't pop file dialogs for untitled whiteboard
       await performBackgroundAutosave();
     }, state.autosaveDelayMs);
     ```
4. Hook `markDirty()` to all mutation points:
   - Stroke commit (after `state.strokes.push` and backend IPC)
   - Eraser delete (`eraseStrokesAt`, `delete_stroke`)
   - Text object added/edited/moved/deleted
   - Image inserted/moved/scaled/deleted
   - Page inserted/deleted/rotated/reordered
   - Undo/Redo operations

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` -> exit 0.

### Step 2: Implement Non-Blocking `performBackgroundAutosave()` in `app.js`

1. Implement `performBackgroundAutosave()`:
   - Guard with `if (state.isSaving) return; state.isSaving = true;`.
   - Update save status indicator to `'saving'`.
   - Collect `nonDeletedStrokes` and `allImages`.
   - Call `invoke('save_pdf', { outPathStr: curTab.pathStr, images: allImages, strokes: nonDeletedStrokes })`.
   - On success:
     - `state.isDirty = false;`
     - `state.lastSaveTime = Date.now();`
     - Update save status indicator to `'saved'`.
   - On error:
     - Log error silently without interrupting the active pen session: `console.warn('[inkwell] Autosave failed:', err);`
     - Update save status indicator to `'error'`.
   - Finally: `state.isSaving = false;`.

**Verify**: `cd inkwell; cargo test` -> exit 0.

### Step 3: Add Autosave Delay Setting Controls and Save Status Indicator in `index.html` & `styles.css`

1. In header (near document title / tabs), add a save status badge:
   ```html
   <div id="saveStatusBadge" class="save-status-badge" title="Autosave status">
     <span class="save-status-dot"></span>
     <span id="saveStatusText" class="save-status-text">Saved</span>
   </div>
   ```
2. In Settings modal / dropdown, add an Autosave Delay selector:
   ```html
   <div class="setting-row">
     <label for="selectAutosaveDelay">Autosave Delay</label>
     <select id="selectAutosaveDelay" class="setting-select">
       <option value="0">Off (Manual Ctrl+S only)</option>
       <option value="500">500 ms (Instant)</option>
       <option value="1000">1 second</option>
       <option value="2000" selected>2 seconds (Recommended)</option>
       <option value="5000">5 seconds</option>
       <option value="10000">10 seconds</option>
       <option value="30000">30 seconds</option>
     </select>
   </div>
   ```
3. Wire the change event:
   ```javascript
   $('selectAutosaveDelay').addEventListener('change', (e) => {
     const val = parseInt(e.target.value, 10);
     state.autosaveDelayMs = val;
     state.autosaveEnabled = val > 0;
     localStorage.setItem('inkwell_autosave_delay_ms', String(val));
     localStorage.setItem('inkwell_autosave_enabled', String(val > 0));
     showToast(`Autosave set to ${val > 0 ? val / 1000 + 's after delay' : 'Off'}`, 'info');
   });
   ```

**Verify**: `cd e2e-tests; py -3 run_all.py` -> exit 0.

## Test plan

- Test that drawing a stroke sets `isDirty = true` and updates badge to "Unsaved".
- Test that after idle duration (e.g. 2s), `performBackgroundAutosave` executes and sets badge to "Saved".
- Test that selecting "Off (0)" disables autosave.
- Test that autosave does not block pen drawing or cause frame drops.

## Done criteria

- [ ] Autosave delay can be configured (Off, 500ms, 1s, 2s, 5s, 10s, 30s) and persists in localStorage.
- [ ] Document dirty state is tracked accurately on every stroke, image, text, and page edit.
- [ ] Background save executes seamlessly after idle delay without freezing UI or opening blocking dialogs.
- [ ] Save status badge displays current state (Saved, Saving..., Unsaved changes).
- [ ] All verification commands pass (`cargo test`, `test_smoke.py`, `run_all.py`, `clippy`).
