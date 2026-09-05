# Plan 055: Synchronize WAL IPC Mutations for Image, Text, and Batch Undo/Redo Events

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3f3e8d..HEAD -- inkwell-app/src/js/main.js inkwell-app/test_app_smoke.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3f3e8d`, 2026-09-05

## Why this matters

The Write-Ahead Log (WAL) engine guarantees that any committed mutation survives sudden application crashes and system reboots. In `inkwell-app/src/js/main.js:1300-1337`, the `documentChanged` event listener synchronizes undo/redo operations with the backend WAL via Tauri IPC. However, it only handles stroke undo/redo events (`undo_add_stroke`, `undo_erase_strokes`, `redo_add_stroke`, `redo_erase_strokes`).

It completely ignores undo/redo events for images (`undo_add_image`, `undo_delete_image`, `redo_add_image`, `redo_delete_image`), text objects / sticky notes (`undo_add_text_object`, `undo_delete_text_object`, `redo_add_text_object`, `redo_delete_text_object`), batch multi-object deletions (`undo_delete_objects`, `redo_delete_objects`, `undo_add_objects`, `redo_add_objects`), and spatial transformations (`undo_transform_objects`, `redo_transform_objects`). If a user modifies or undoes image/text/lasso operations and the app restarts, the WAL replay desynchronizes from the user's expected document state.

## Current state

The relevant files and lines:
- `inkwell-app/src/js/main.js` (lines 1299–1337):
```javascript
    if (!evt) return;
    const type = evt.type;
    const data = evt.payload || {};

    if (type === 'undo_add_stroke') {
      if (data.stroke && data.stroke.id) {
        ipc.deleteStroke(data.stroke.id).catch(err => {
          console.warn('[inkwell/main] undo_add_stroke deleteStroke error:', err);
        });
      }
    } else if (type === 'undo_erase_strokes') {
      if (Array.isArray(data.strokes)) {
        for (const s of data.strokes) {
          if (s) {
            ipc.commitStroke(s.sheet, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id).catch(err => {
              console.warn('[inkwell/main] undo_erase_strokes commitStroke error:', err);
            });
          }
        }
      }
    } else if (type === 'redo_add_stroke') {
      if (data.stroke) {
        const s = data.stroke;
        ipc.commitStroke(s.sheet, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id).catch(err => {
          console.warn('[inkwell/main] redo_add_stroke commitStroke error:', err);
        });
      }
    } else if (type === 'redo_erase_strokes') {
      if (Array.isArray(data.strokes)) {
        for (const s of data.strokes) {
          if (s && s.id) {
            ipc.deleteStroke(s.id).catch(err => {
              console.warn('[inkwell/main] redo_erase_strokes deleteStroke error:', err);
            });
          }
        }
      }
    }
```

- `inkwell-app/src/js/core/ipc.js` (lines 136–200):
Exports `journalImageMutation(op, imgObj)` (`'upsert'` | `'delete'`) and `journalTextMutation(op, textObj)` (`'upsert'` | `'delete'`).

- `inkwell-app/src/js/core/document.js` (lines 352–410, 429–485):
Dispatches `undo_delete_objects`, `undo_add_objects`, `undo_add_image`, `undo_delete_image`, `undo_add_text_object`, `undo_delete_text_object`, `undo_transform_objects`, and their corresponding `redo_*` events.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop App Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all checks pass |
| Rust Workspace Tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all pass |

## Scope

**In scope**:
- `inkwell-app/src/js/main.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- `inkwell/crates/inkwell-core/src/wal.rs`
- `inkwell-app/src/js/core/history.js`

## Steps

### Step 1: Wire image undo/redo handlers to WAL IPC

In `inkwell-app/src/js/main.js`, add handlers inside the `documentChanged` event callback:

```javascript
    } else if (type === 'undo_add_image' || type === 'redo_delete_image') {
      if (data.image) ipc.journalImageMutation('delete', data.image);
    } else if (type === 'undo_delete_image' || type === 'redo_add_image') {
      if (data.image) ipc.journalImageMutation('upsert', data.image);
```

**Verify**:
`grep -rn "undo_add_image" inkwell-app/src/js/main.js` → matches found.

### Step 2: Wire text object undo/redo handlers to WAL IPC

In `inkwell-app/src/js/main.js`, add text object handlers:

```javascript
    } else if (type === 'undo_add_text_object' || type === 'redo_delete_text_object') {
      if (data.textObj) ipc.journalTextMutation('delete', data.textObj);
    } else if (type === 'undo_delete_text_object' || type === 'redo_add_text_object') {
      if (data.textObj) ipc.journalTextMutation('upsert', data.textObj);
```

**Verify**:
`grep -rn "undo_add_text_object" inkwell-app/src/js/main.js` → matches found.

### Step 3: Wire batch object deletion/addition and transform handlers to WAL IPC

In `inkwell-app/src/js/main.js`, handle multi-object mutations:

```javascript
    } else if (type === 'undo_delete_objects' || type === 'redo_add_objects') {
      for (const s of (data.strokes || [])) {
        if (s) ipc.commitStroke(s.sheet, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id);
      }
      for (const img of (data.images || [])) {
        if (img) ipc.journalImageMutation('upsert', img);
      }
      for (const t of (data.textObjects || [])) {
        if (t) ipc.journalTextMutation('upsert', t);
      }
    } else if (type === 'redo_delete_objects' || type === 'undo_add_objects') {
      for (const s of (data.strokes || [])) {
        if (s && s.id) ipc.deleteStroke(s.id);
      }
      for (const img of (data.images || [])) {
        if (img) ipc.journalImageMutation('delete', img);
      }
      for (const t of (data.textObjects || [])) {
        if (t) ipc.journalTextMutation('delete', t);
      }
    } else if (type === 'undo_transform_objects' || type === 'redo_transform_objects') {
      const isUndo = type === 'undo_transform_objects';
      const strokeList = isUndo ? data.initialStrokes : data.finalStrokes;
      const imageList = isUndo ? data.initialImages : data.finalImages;
      const textList = isUndo ? data.initialTextObjects : data.finalTextObjects;

      for (const s of (strokeList || [])) {
        if (s) ipc.commitStroke(s.sheet || 0, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id);
      }
      for (const img of (imageList || [])) {
        if (img) ipc.journalImageMutation('upsert', img);
      }
      for (const t of (textList || [])) {
        if (t) ipc.journalTextMutation('upsert', t);
      }
    }
```

**Verify**:
`grep -rn "undo_delete_objects" inkwell-app/src/js/main.js` → matches found.

### Step 4: Add smoke verification in `test_app_smoke.py`

In `inkwell-app/test_app_smoke.py`, verify that executing an undo/redo on a text object and an image triggers the corresponding Tauri mock methods without throwing exceptions.

**Verify**:
`cd inkwell-app; py -3 test_app_smoke.py` → exit 0, all checks pass.

## Test plan

- Test: Perform `documentOps.addTextObject(...)` followed by `documentOps.performUndo()`. Verify mock `journal_text_mutation` receives `op: 'delete'`.
- Test: Perform `documentOps.performRedo()`. Verify mock `journal_text_mutation` receives `op: 'upsert'`.
- Verification command: `cd inkwell-app; py -3 test_app_smoke.py`

## Done criteria

Machine-checkable. ALL must hold:
- [ ] `grep -rn "undo_add_image" inkwell-app/src/js/main.js` returns matches.
- [ ] `grep -rn "undo_add_text_object" inkwell-app/src/js/main.js` returns matches.
- [ ] `grep -rn "undo_delete_objects" inkwell-app/src/js/main.js` returns matches.
- [ ] `cd inkwell-app; py -3 test_app_smoke.py` exits 0 with all checks passing.
- [ ] No files outside `inkwell-app/src/js/main.js` and `inkwell-app/test_app_smoke.py` are modified (`git status`).
- [ ] `plans/README.md` status row updated for Plan 055.

## STOP conditions

Stop and report back (do not improvise) if:
- `ipc.journalImageMutation` or `ipc.journalTextMutation` does not exist in `core/ipc.js`.
- The signature of `ipc.commitStroke` has changed.

## Maintenance notes

- When new object types are introduced to the document model (e.g. vector shapes or audio clips), their undo/redo actions must similarly be registered in `main.js:documentChanged`.
