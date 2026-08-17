# Plan 028: Multi-Document Tab Session Synchronization & Backend State Isolation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell-app/src-tauri/src/state.rs inkwell-app/src-tauri/src/commands.rs inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/027-page-lifecycle-layout-sync-and-insertion-dialog.md
- **Category**: bug / architecture
- **Planned at**: commit `8337e2c`, 2026-08-17

## Why this matters

The frontend UI exposes a multi-document tab bar allowing users to open several PDFs simultaneously. However, the Tauri backend (`AppState`) stores document state (`doc`, `pdf_path`, `pdf_bytes`, `wal`, `page_bitmap_cache`) in single global `Mutex` options. When a user creates a second tab or switches tabs, the backend remains locked to the first document's PDF bytes and WAL stream. Inking on Tab 2 writes strokes into Tab 1's WAL journal and tile rendering on Tab 2 queries Tab 1's PDFium byte slice, resulting in cross-document data corruption and rendering errors.

## Current state

- `inkwell-app/src-tauri/src/state.rs:60-73`: `AppState` has single global fields `doc: Mutex<Option<Document>>`, `pdf_path: Mutex<Option<PathBuf>>`, `pdf_bytes: Mutex<Option<Arc<Vec<u8>>>>`, and `wal: Mutex<Option<Sender<WalOp>>>`.
- `inkwell-app/src-tauri/src/commands.rs:366-372`: `render_tile` acquires `state.pdf_bytes` globally without specifying a tab ID or document session key.
- `inkwell-app/src/js/app.js:2812-2860`: `switchTab(tabId)` stores local state into `curTab` and updates `state.strokes`/`pageInfos`, but never issues an IPC call to tell the Rust backend to switch active document sessions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |

## Scope

**In scope** (the only files you should modify):
- `inkwell-app/src-tauri/src/state.rs`
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/app.js`

**Out of scope** (do NOT touch):
- `inkwell/crates/inkwell-core/src/wal.rs`
- `inkwell/crates/inkwell-pdf/src/pdf.rs`

## Git workflow

- Branch: `advisor/028-multi-document-tab-backend-sync`
- Commit message: `feat(tabs): implement backend document session registry and tab isolation`

## Steps

### Step 1: Implement `DocumentSession` and Session Map in `state.rs`

In `inkwell-app/src-tauri/src/state.rs`:
1. Define a `DocumentSession` struct containing:
   ```rust
   pub struct DocumentSession {
       pub id: String,
       pub doc: Document,
       pub pdf_path: Option<PathBuf>,
       pub pdf_bytes: Arc<Vec<u8>>,
       pub wal: Option<Sender<WalOp>>,
       pub page_bitmap_cache: PageBitmapLruCache,
   }
   ```
2. Refactor `AppState` to hold:
   ```rust
   pub struct AppState {
       pub sessions: Mutex<std::collections::HashMap<String, DocumentSession>>,
       pub active_session_id: Mutex<Option<String>>,
       pub pdfium: Mutex<Option<Pdfium>>,
       pub tile_cache: Mutex<TileCache>,
   }
   ```
3. Provide helper methods `with_active_session` and `with_active_session_mut` to preserve backwards compatibility and ensure clean session extraction.

**Verify**: `cd inkwell; cargo test` → exit 0

### Step 2: Add Session Management IPC Commands in `commands.rs`

In `inkwell-app/src-tauri/src/commands.rs`:
1. Update `open_pdf`, `open_pdf_bytes`, and `create_blank_document` to accept an optional `session_id: Option<String>`. If provided, register or update the session in `state.sessions`.
2. Add command `switch_document_session(session_id: String, state: State<'_, AppState>) -> Result<bool, String>`:
   - Sets `state.active_session_id = Some(session_id)`.
3. Add command `close_document_session(session_id: String, state: State<'_, AppState>) -> Result<bool, String>`:
   - Closes WAL worker thread for the session and removes it from `state.sessions`.
4. Update `render_tile`, `commit_stroke`, `delete_stroke`, `save_pdf`, and `insert_blank_page` to operate on the active `DocumentSession`.

**Verify**: `cd inkwell; cargo clippy --all-targets` → zero warnings

### Step 3: Connect Frontend Tab Switching to Backend Sessions in `app.js`

In `inkwell-app/src/js/app.js`:
1. Update `createTab()` to pass `tabId` to `open_pdf` / `open_pdf_bytes` / `create_blank_document`.
2. In `switchTab(tabId)`, invoke `switch_document_session` with `tabId` and wait for confirmation before calling `scheduleRedrawTiles()`.
3. In `closeTab(tabId)`, invoke `close_document_session` with `tabId`.
4. Add dirty state tracking to tab titles (display `●` dot when document has uncommitted or modified strokes).

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0, 18/18 checks pass

## Test plan

- Open Document A in Tab 1, draw a red stroke.
- Open Document B in Tab 2, draw a blue stroke.
- Switch between Tab 1 and Tab 2 multiple times; verify Tab 1 retains only red strokes and Tab 2 retains only blue strokes.
- Verify tile rendering in Tab 2 does not display pages from Document A.
- Save Document B and verify only Document B bytes are written to disk.

## Done criteria

- [ ] Each tab corresponds to an isolated `DocumentSession` in Rust backend
- [ ] Switching tabs cleanly swaps active PDF bytes, strokes, WAL channel, and bitmap cache
- [ ] Closing a tab shuts down its background WAL worker thread and frees rasterizer bitmaps
- [ ] No cross-tab stroke pollution or PDFium rasterizer bleed occurs
- [ ] `cd inkwell; cargo test` exits 0
- [ ] `cd inkwell-m0; py -3 test_smoke.py` exits 0

## STOP conditions

- If memory usage exceeds 500MB when opening 5 tabs, stop and verify `page_bitmap_cache` LRU capacity bounds.
- If switching tabs causes a race condition during active inking, ensure pointer capture cancels active wet stroke before tab transition.

## Maintenance notes

- Future tab-drag tear-off windows will be able to connect directly to these isolated `DocumentSession` instances.
