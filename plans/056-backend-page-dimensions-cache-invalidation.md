# Plan 056: Invalidate Backend Page Dimensions Cache on Page Lifecycle Mutations

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3f3e8d..HEAD -- inkwell-app/src-tauri/src/commands.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3f3e8d`, 2026-09-05

## Why this matters

In `inkwell-app/src-tauri/src/commands.rs`, `AppState.page_dimensions` maintains an in-memory `HashMap<u32, (f64, f64)>` mapping page indices to their width and height in points. This cache is queried by `render_tile` to avoid costly PDF page object parsing during interactive panning and zooming.

However, when page lifecycle mutations occur—namely `insert_blank_page`, `delete_page`, `duplicate_page`, `rotate_page`, and `reorder_page`—the backend clears `page_bitmap_cache` but forgets to clear `page_dimensions`. Consequently:
1. When a page is rotated (e.g., 90° from portrait 595x842 to landscape 842x595), `render_tile` retrieves the stale portrait dimensions from cache, causing aspect ratio distortion and pixel shearing in the rendered tiles.
2. When pages are inserted, deleted, or reordered, all shifted page indices serve dimensions from whatever page was previously at that index.

Invalidating `page_dimensions` on every page lifecycle mutation ensures dimensions always match the actual current PDF state.

## Current state

The relevant files and lines:
- `inkwell-app/src-tauri/src/commands.rs` (lines 517–526, `render_tile` cache lookup):
```rust
        let (w_pt, h_pt) = {
            let dim_guard = state.page_dimensions.lock().map_err(|e| format!("Lock error: {e}"))?;
            if let Some(&(w, h)) = dim_guard.get(&(page as u32)) {
                (w, h)
            } else {
                drop(dim_guard);
                let pdfium_guard = state.pdfium.lock().unwrap();
                // loads page and writes into page_dimensions
```

- `inkwell-app/src-tauri/src/commands.rs` (line 1120, `insert_blank_page` clears only bitmap cache):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
```

- `inkwell-app/src-tauri/src/commands.rs` (line 1374, `delete_page` clears only bitmap cache):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
```

- `inkwell-app/src-tauri/src/commands.rs` (line 1421, `duplicate_page` clears only bitmap cache):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
```

- `inkwell-app/src-tauri/src/commands.rs` (line 1473, `rotate_page` clears only bitmap cache):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
```

- `inkwell-app/src-tauri/src/commands.rs` (line 1527, `reorder_page` clears only bitmap cache):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Workspace Tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all pass |
| Rust Linter | `cd inkwell; cargo clippy --all-targets` | exit 0, zero warnings |
| Desktop App Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all checks pass |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs`

**Out of scope**:
- `inkwell/crates/inkwell-pdf/`
- Frontend JavaScript files

## Steps

### Step 1: Invalidate `page_dimensions` in all page lifecycle mutation commands

In `inkwell-app/src-tauri/src/commands.rs`:

1. In `insert_blank_page` (near line 1120):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }
```

2. In `delete_page` (near line 1374):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }
```

3. In `duplicate_page` (near line 1421):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }
```

4. In `rotate_page` (near line 1473):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }
```

5. In `reorder_page` (near line 1527):
```rust
    state.page_bitmap_cache.lock().unwrap().clear();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }
```

**Verify**:
`cd inkwell-app/src-tauri; cargo check` → exit 0, no errors.

### Step 2: Verify Clippy and Workspace Tests

Run Clippy and unit test suite to verify no deadlock risks or type mismatches.

**Verify**:
`cd inkwell; cargo clippy --all-targets` → zero warnings.
`cd inkwell; cargo test --workspace -- --test-threads=1` → all tests pass.

## Test plan

- Test: Check that mutating a document via page insertion, deletion, rotation, and reordering does not cause stale dimension lookups in `commands.rs`.
- Verification command: `cd inkwell; cargo test --workspace -- --test-threads=1`
- Verification command: `cd inkwell-app; py -3 test_app_smoke.py`

## Done criteria

Machine-checkable. ALL must hold:
- [ ] In `commands.rs`, each of `insert_blank_page`, `delete_page`, `duplicate_page`, `rotate_page`, and `reorder_page` clears `state.page_dimensions`.
- [ ] `cd inkwell; cargo clippy --all-targets` produces 0 warnings.
- [ ] `cd inkwell; cargo test --workspace -- --test-threads=1` exits 0.
- [ ] `cd inkwell-app; py -3 test_app_smoke.py` exits 0.
- [ ] No files outside `inkwell-app/src-tauri/src/commands.rs` are modified (`git status`).
- [ ] `plans/README.md` status row updated for Plan 056.

## STOP conditions

Stop and report back (do not improvise) if:
- `AppState` in `state.rs` does not contain `page_dimensions`.
- The mutex lock on `state.page_dimensions` differs in signature or type.

## Maintenance notes

- If a fine-grained dimension update mechanism (e.g. key shifting instead of full cache flush) is ever introduced, ensure rotation explicitly swaps the width and height of the targeted index.
