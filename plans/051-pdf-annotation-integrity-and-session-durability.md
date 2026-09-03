# Plan 051: PDF Annotation Integrity, Undo/Redo IPC Synchronization & Durability Hardening

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat bd18cc4..HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell-app/src/js/core/document.js inkwell-app/src/js/core/clipboard.js inkwell-app/src/js/main.js inkwell/crates/inkwell-core/src/pdf.rs inkwell/crates/inkwell-core/src/wal.rs`
> Confirm live code matches the excerpts below; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: correctness / durability / data integrity
- **Planned at**: commit `bd18cc4`, 2026-09-03 (reconciled against clean HEAD)

## Why this matters

Several critical data integrity bugs cause annotations to disappear, strokes to resurrect after undo, or crash recovery to link to incorrect files:
1. In `commands.rs::render_tile`, annotations are currently disabled (`render_annotations(false)`). When enabling annotations (`render_annotations(true)`), third-party annotations (from Adobe Acrobat, Okular, Apple PDFKit) must be rendered onto background bitmap tiles while InkWell-authored annotations (`creator == "Inkwell"`) must be filtered out in-memory so they are not baked into background bitmaps (preserving interactive erasing and selection).
2. In `document.js`, `performUndo` marks `tx.stroke.deleted = true` in frontend JavaScript memory only, never dispatching `delete_stroke` to the backend. Similarly, undoing an erase marks `deleted = false` in JS only, never notifying the backend. Consequently, undid strokes remain in the Rust document and WAL, resurrecting after crash recovery, while un-erased strokes are omitted upon PDF save.
3. In `pdf.rs`, `page_box` does not normalize coordinates where `lly > ury` or `llx > urx` (permitted by ISO 32000-1 §7.7.3.3), leading to inverted `/Rect` and displaced `/BBox` arrays that compliant PDF readers reject.
4. When executing "Save As", `save_pdf` updates `state.pdf_path` but leaves the WAL worker bound to the original file path. Subsequent edits continue appending to the old file's WAL journal.
5. `wal.rs::atomic_write` uses a static `.inkwell-tmp` filename without process ID or random nonce, causing collision if multiple documents save concurrently, and leaves orphaned temp files if rename fails.

## Current state

- `inkwell-app/src-tauri/src/commands.rs`:
  ```rust
  // Lines 550-554:
  let config = PdfRenderConfig::new()
      .set_target_width(target_w)
      .set_maximum_height(target_h)
      .set_clear_color(PdfColor::WHITE)
      .render_annotations(false);
  ```
- `inkwell-app/src/js/core/document.js`:
  ```javascript
  // Lines 342-351:
  if (tx.type === 'add_stroke' && tx.stroke) {
    tx.stroke.deleted = true;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_add_stroke', { stroke: tx.stroke });
  } else if (tx.type === 'erase_strokes' && tx.strokes) {
    for (const s of tx.strokes) s.deleted = false;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_erase_strokes', { strokes: tx.strokes });
  }
  ```
- `inkwell/crates/inkwell-core/src/pdf.rs`:
  ```rust
  // Lines 174-178:
  if let Some(r) = box_ref {
      if let Some(nums) = self.resolve_rectangle(r) {
          return nums;
      }
  }
  ```
- `inkwell/crates/inkwell-core/src/wal.rs`:
  ```rust
  // Lines 358-361:
  let tmp = dir.join(format!(
      ".{}.inkwell-tmp",
      target.file_name().unwrap().to_string_lossy()
  ));
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust workspace tests | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |
| Tauri backend check | `cd inkwell-app/src-tauri && cargo check` | exit 0 |
| Frontend syntax check | `node --check inkwell-app/src/js/core/document.js && node --check inkwell-app/src/js/main.js` | exit 0 |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/core/document.js`
- `inkwell-app/src/js/core/clipboard.js`
- `inkwell-app/src/js/main.js`
- `inkwell/crates/inkwell-core/src/pdf.rs`
- `inkwell/crates/inkwell-core/src/wal.rs`

**Out of scope**:
- Do not modify One-Euro filter mathematics or stroke ribbon geometry in `ink.rs`.
- Do not change third-party PDFium binary bindings.

## Steps

### Step 1: Render Third-Party Annotations and Filter Out InkWell-Authored Annotations in `commands.rs`

In `inkwell-app/src-tauri/src/commands.rs::render_tile`:
Enable annotation rendering in `PdfRenderConfig`, and delete only InkWell-authored annotations from the in-memory page before rendering:
```rust
let mut page_obj = doc.pages_mut().get(page as i32).map_err(|e| format!("PDFium page error: {e:?}"))?;

// Filter out InkWell-authored annotations in-memory so they are not baked into
// the background bitmap tile (avoiding ghosting and preserving full interactive erasing/selection).
// Third-party annotations (from Okular, Acrobat, Drawboard, etc.) are preserved and rendered.
let annot_count = page_obj.annotations().len();
for i in (0..annot_count).rev() {
    let is_inkwell = if let Ok(annot) = page_obj.annotations().get(i) {
        annot.creator().as_deref() == Some("Inkwell")
    } else {
        false
    };
    if is_inkwell {
        let annots = page_obj.annotations_mut();
        if let Ok(annot) = annots.get(i) {
            let _ = annots.delete_annotation(annot);
        }
    }
}

let config = PdfRenderConfig::new()
    .set_target_width(target_w)
    .set_maximum_height(target_h)
    .set_clear_color(PdfColor::WHITE)
    .render_annotations(true);
```

**Verify**: `cd inkwell-app/src-tauri && cargo check` → exit 0.

### Step 2: Synchronize Undo/Redo Dispatches with Backend IPC

1. In `main.js`:
   Listen to `documentChanged` events for `undo_add_stroke`, `undo_erase_strokes`, `redo_add_stroke`, `redo_erase_strokes`:
   - On `undo_add_stroke`: call `ipc.deleteStroke(data.stroke.id)`.
   - On `undo_erase_strokes`: call `ipc.commitStroke(s)` for each restored stroke.
   - On `redo_add_stroke`: call `ipc.commitStroke(data.stroke)`.
   - On `redo_erase_strokes`: call `ipc.deleteStroke(s.id)` for each re-deleted stroke.
2. In `core/clipboard.js`:
   Ensure `pasteClipboard` dispatches `ipc.commitStroke(s)` for all newly pasted strokes.

**Verify**: `node --check inkwell-app/src/js/core/document.js && node --check inkwell-app/src/js/core/clipboard.js && node --check inkwell-app/src/js/main.js` → exit 0.

### Step 3: Normalise Bounding Box Coordinates in `pdf.rs`

In `inkwell/crates/inkwell-core/src/pdf.rs`:
1. In `page_box`: ensure `[llx, lly, urx, ury]` always has `llx <= urx` and `lly <= ury`:
   ```rust
   if let Some(r) = box_ref {
       if let Some(nums) = self.resolve_rectangle(r) {
           let (llx, urx) = if nums[0] <= nums[2] { (nums[0], nums[2]) } else { (nums[2], nums[0]) };
           let (lly, ury) = if nums[1] <= nums[3] { (nums[1], nums[3]) } else { (nums[3], nums[1]) };
           return [llx, lly, urx, ury];
       }
   }
   ```

**Verify**: `cd inkwell && cargo test --workspace -- --test-threads=1` → exit 0.

### Step 4: Rebind WAL Worker on "Save As" in `commands.rs`

In `commands.rs::save_pdf`:
When `target_path` differs from the current `*state.pdf_path`:
1. Send `WalOp::Close` to the existing WAL worker channel.
2. Initialize a new WAL worker targeting `wal_path_for(&target_path)`.
3. Store the new channel transmitter in `*state.wal.lock().unwrap()`.

**Verify**: `cd inkwell-app/src-tauri && cargo check` → exit 0.

### Step 5: Add Nonce and Cleanup Guard to `atomic_write` in `wal.rs`

In `inkwell/crates/inkwell-core/src/wal.rs::atomic_write`:
Generate a unique temp file using process ID and monotonic counter:
```rust
use std::sync::atomic::{AtomicU64, Ordering};
static COUNTER: AtomicU64 = AtomicU64::new(0);

let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
let pid = std::process::id();
let tmp = dir.join(format!(
    ".{}.inkwell-tmp-{}-{}",
    target.file_name().unwrap().to_string_lossy(),
    pid,
    nonce
));
```
If `std::fs::rename` fails, explicitly remove `tmp` before returning the error:
```rust
if let Err(e) = std::fs::rename(&tmp, target) {
    let _ = std::fs::remove_file(&tmp);
    return Err(e);
}
```

**Verify**: `cd inkwell && cargo test --workspace -- --test-threads=1` → exit 0.

## Done criteria

- [ ] Non-InkWell annotations are preserved when rendering tiles with annotations enabled.
- [ ] Undo and redo actions notify the backend and sync with WAL and `state.doc`.
- [ ] Coordinate normalisation guarantees `llx <= urx` and `lly <= ury` in `pdf.rs`.
- [ ] "Save As" rebinds WAL worker channel to the new target file path.
- [ ] Atomic save incorporates PID + nonce and cleans up temp files on failure.
