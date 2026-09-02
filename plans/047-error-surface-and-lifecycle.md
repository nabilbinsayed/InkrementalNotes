# Plan 047: Error Surface & Session-Lifecycle Honesty — No Swallowed Failures, Working Quit-Save, Dead UI Triage

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: Written against working tree at `aef1b6a`.
> Confirm excerpts match; on mismatch STOP and report.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/041 (save path), plans/043 (shared main.js edits — merge after it)
- **Category**: bug / dx / tech-debt
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

Root `AGENTS.md` Rule 5 forbids swallowed errors, yet durability-relevant
failures are silenced across the frontend (`catch(() => {})` on stroke/image
deletes, WAL commit failures reduced to console.warn in a release webview where
nobody sees the console). Separately, the quit-with-unsaved-changes flow is
dead code both ways: the backend `is_dirty` flag is only set by a command
nothing calls, so the save prompt can never appear, and even if it did, the
`app-save-and-close` event it emits has no frontend listener — clicking "Save"
would hang the window. Finally, ~50 UI element IDs have no JS wiring at all
(settings controls, bookmarks, layers drawer, recent files, selection toolbar,
export options, confirm modals); each silent dead control erodes trust. This
plan makes failures visible, makes quit-save work or honestly absent, and
either wires or removes the highest-traffic dead controls.

## Current state

Swallowed / invisible errors:
- `inkwell-app/src/js/tools/shapes.js:121` — `.catch(() => {})` on
  `ipc.commitStroke` (041 already fixes this one; verify).
- `inkwell-app/src/js/tools/eraser.js:84` — `.catch(() => {})` on
  `ipc.deleteStroke`.
- `inkwell-app/src/js/core/ipc.js:109,115,138,144` — journal mutation errors →
  `console.warn`.
- `main.js:106,145,356,415,470` — toasts stringifying raw exceptions:
  `'Save failed: ' + e`.

Quit flow:
- `inkwell-app/src-tauri/src/main.rs:44–81`: on CloseRequested with dirty →
  dialog → OK emits `"app-save-and-close"`; Cancel/discard exits.
  `rg -n "app-save-and-close" inkwell-app/src/js` → 0 matches.
- `commands.rs:1464–1467` `set_document_dirty(dirty)` — zero frontend callers;
  `state.is_dirty` therefore never true; the prompt never fires.
- A full close-confirm modal EXISTS unused in index.html:
  `confirmCloseModal`, `btnConfirmCloseCancel/Discard/Save`
  (all in the unwired-ID list).

Dead high-traffic controls (from the ID sweep — 128 of 252 IDs unreferenced):
settings tab controls (`selectAutosaveDelay`, `cCoalesced`,
`selectDefaultTemplate`, `cRestoreSession`), bookmarks (`btnAddBookmark`,
`drawerBookmarks`), layers (`layersList`), recent files
(`recentFilesList`, `btnClearRecents`), floating selection toolbar
(`selectionToolbar`, `btnSelCopy/Cut/Duplicate/Delete`), export modal options
(`btnExportIncremental`, `btnExportFlattened`), insert-page form fields
(`insertPositionSelect`, `insertPaperSizeSelect`, `customDimRow`,
`customPageWidth/Height`, `insertTemplateSelect`, `btnConfirmInsertPage`),
pane page-nav clusters (`btnLeftPanePrev/Next`, `btnRightPanePrev/Next`),
custom zoom (`inputCustomZoom`, `btnApplyCustomZoom`).

Note: `state.autosaveDelayMs` READS `localStorage 'inkwell_autosave_delay'`
(state.js:139) but nothing ever WRITES that key — the settings select is a
no-op today.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Backend check | `cd inkwell-app/src-tauri; cargo check` | exit 0 |
| App smoke | `cd inkwell-app; py -3 test_app_smoke.py` | all pass |
| JS syntax | `node --check <file>` per edit | exit 0 |

## Scope

**In scope**:
- `inkwell-app/src/js/core/ipc.js`, `tools/eraser.js`, `main.js`,
  `ui/toolbar.js`, `ui/drawers.js`, `core/state.js` (autosave writer)
- `inkwell-app/src-tauri/src/main.rs` (quit-flow fix)
- `inkwell-app/src/index.html` (hide truly-unimplementable dead controls)

**Out of scope** (do NOT touch):
- Rust command implementations beyond main.rs window-event wiring.
- Re-implementing bookmarks/layers/recent-files FEATURES (they need design);
  this plan only wires-or-hides per Step 4's dispositions.
- `styles.css` except where hiding requires no change (use `hidden` attribute).

## Git workflow

- Branch: `advisor/047-error-surface-and-lifecycle`
- Commit per step; style: `fix(ux): surface durability errors and repair quit-save`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Surface durability failures via toast (with dedupe)

Add to `core/state.js` (or a tiny new helper inside ipc.js) a coalescing
notifier:

```js
let _lastToastAt = 0;
export function warnDurability(message) {
  const now = Date.now();
  if (now - _lastToastAt < 4000) return;   // dedupe storms
  _lastToastAt = now;
  emit('toast', { message, type: 'error' });
}
```

Then:
- `eraser.js:84`: `.catch(err => warnDurability('Erase may not persist: ' + err))`
  (import from state.js).
- `ipc.js` journal catchers: replace `console.warn(...)` with
  `console.warn(...)` PLUS `warnDurability('Change journal unavailable — unsaved work at risk')`.
- Keep pen.js's commitStroke catch as console.warn + add the same
  warnDurability call.

**Verify**: `rg -n "\.catch\(\(\) => \{\}\)" inkwell-app/src/js` → 0 matches.

### Step 2: Human-readable failure messages

In `main.js`, wrap the four raw-stringify toasts with a small mapper:

```js
function friendlyError(e) {
  if (typeof e === 'string') {
    if (/CANCELLED/i.test(e)) return null;
    if (/lock|denied|permission/i.test(e)) return 'File is locked — close it in other apps and retry.';
    if (/No document open|No PDF/i.test(e)) return 'Open a document first.';
    return e;
  }
  return (e && e.message) ? e.message : 'Unexpected error';
}
```

Use it at the five sites; skip the toast entirely when it returns null.

**Verify**: `node --check main.js`; `rg -n "' \+ e," main.js` reviewed manually.

### Step 3: Make quit-save real

Frontend: in `main.js` bootstrap, listen for the backend event using the
Tauri event API via the global bridge:

```js
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen('app-save-and-close', async () => {
    try {
      await commandsModule.commands.execute('file.save');
      if (window.forceCloseWindow) await window.forceCloseWindow();
      else window.close();
    } catch (e) {
      toast.showToast('Could not save on exit: ' + friendlyError(e), 'error');
    }
  });
}
```

Backend: make dirty tracking honest — in `commands.rs` `commit_stroke`,
`delete_stroke`, `journal_image_mutation`, `journal_text_mutation`,
`insert_blank_page`, `delete_page`, `duplicate_page`, `reorder_page`:
after a successful mutation add
`state.is_dirty.store(true, Ordering::Relaxed);`. In `save_pdf` success path
(before WalOp::Truncate) store `false`. This replaces reliance on the
never-called `set_document_dirty` (leave that command registered for API
compatibility).

Also expose `force_close_window` to the frontend bridge in main.js bootstrap:
`window.forceCloseWindow = () => ipc.invokeTauri('force_close_window');`

**Verify**: `cargo check` exit 0; operator: draw → click window X → prompt
appears; OK saves and app exits; reopen shows the stroke. Draw → X → Cancel
(discard) → exits without saving; WAL replay restores the stroke on next open
(existing behavior).

### Step 4: Wire-or-hide disposition for dead controls

For each group, choose WIRE (small, unambiguous) or HIDE (needs feature work):

WIRE:
- `selectAutosaveDelay` → on change write
  `localStorage.setItem('inkwell_autosave_delay', value)` and update
  `state.autosaveDelayMs`; wire the existing autosave timer behavior ONLY IF a
  timer implementation exists in the live tree (`rg -n "autosaveTimer"
  inkwell-app/src/js`) — if none exists, HIDE instead and note it.
- `inputCustomZoom` + `btnApplyCustomZoom` → parse float, clamp 0.15–10,
  `_viewport.setZoom(v, [stageW/2, stageH/2], 'left')` + emitZoomChanged
  (reuse Plan 042 helpers).
- Pane nav clusters (`btnLeftPanePrev/Next`, `btnRightPanePrev/Next`) → call
  the existing `navigation.goToPage(sheet±1, pane, viewport)`; hide the right-
  cluster when not in split mode (toggle a `hidden` class on
  `splitPageNavCluster` from the existing split-toggle handler).

HIDE (add `hidden` attribute + one-line HTML comment "feature pending"):
bookmarks buttons, layers list, recent files block, floating selection
toolbar, export option buttons (keep the modal closed-state as-is),
insert-page advanced fields (`insertPositionSelect`, `insertPaperSizeSelect`,
`customDimRow`, `insertTemplateSelect`) while keeping the basic form working,
both confirm modals (`confirmCloseModal` — superseded by native dialog in
Step 3 — and `confirmDeletePageModal`).

Record every disposition in the PR description as a table.

**Verify**: `node --check` edited files; smoke suite green; operator walks the
Settings tabs — no visibly dead controls remain in the wired set.

### Step 5: Battery

**Verify**: `cd inkwell-app/src-tauri; cargo check` → exit 0;
`cd inkwell; cargo clippy --all-targets` → zero warnings;
`cd inkwell-app; py -3 test_app_smoke.py` → all pass.

## Test plan

- Smoke suite stays green.
- Manual operator script (record results): (a) kill pdfium.dll temporarily →
  open PDF → tile error surfaces as a toast, not silence; (b) quit-save flow
  both branches; (c) autosave-delay select persists across restart (if wired).

## Done criteria

ALL must hold:
- [ ] `rg -n "\.catch\(\(\) => \{\}\)" inkwell-app/src/js` → 0 matches
- [ ] `rg -n "is_dirty.store" inkwell-app/src-tauri/src/commands.rs` → ≥8 matches incl. save_pdf(false)
- [ ] `rg -n "app-save-and-close" inkwell-app/src/js/main.js` → ≥1 match
- [ ] Every control listed in Step 4 is either wired (has a listener) or carries `hidden`
- [ ] Batteries green
- [ ] No files outside scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- The live main.rs quit-flow differs structurally (e.g. already uses a frontend
  confirm modal path).
- Wiring autosave reveals a half-built timer elsewhere that would double-fire
  saves — report its location instead of reconciling here.
- Hiding any Step-4 control would break an existing automated test (none known).

## Maintenance notes

- The remaining ~60 unwired IDs are cosmetic/structural containers; re-run the
  ID-sweep after this plan and keep the count in plans/README as a health metric.
- If bookmarks/recent-files get designed later, start from the hidden markup
  rather than new DOM.
- Reviewer focus: dirty-flag coverage — grep every mutating command and
  confirm none was missed.
