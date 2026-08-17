# Plan 022: Multi-Document Tab Backend Synchronization and Full Mutation State Durability

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1154947..HEAD -- inkwell-app/src-tauri/src/state.rs inkwell-app/src-tauri/src/commands.rs inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1154947`, 2026-08-14

## Why this matters

The frontend UI supports multiple document tabs, but the backend `AppState` maintains only a single global document, single WAL sender, and single byte slice. Switching tabs leaves the backend attached to the most recently opened file, so strokes drawn on Tab A are logged to Tab B's WAL and saving Tab A overwrites Tab A with Tab B's contents. In addition, Undo/Redo, Lasso deletions, and duplicated/pasted objects mutate frontend memory without synchronizing to the Rust `Document` or WAL journal. Unifying backend session management and synchronizing all mutations guarantees complete data durability and crash safety.

## Current state

- `inkwell-app/src-tauri/src/state.rs:60-73` — `AppState` contains a single `doc`, `pdf_path`, `pdf_bytes`, and `wal` sender.
- `inkwell-app/src/js/app.js:2593-2641` — `switchTab()` updates frontend tabs without notifying backend IPC.
- `inkwell-app/src/js/app.js:2243-2282` — `undo()` and `redo()` modify `stroke.deleted` in JS only, never calling `delete_stroke` or logging WAL deletions.
- `inkwell-app/src/js/app.js:1058-1189` — `deleteSelection()`, `duplicateSelection()`, and `pasteClipboard()` mutate frontend strokes without dispatching `commit_stroke` or `delete_stroke` to Rust core.
- `inkwell-app/src-tauri/src/commands.rs:9-30, 511` — WAL append is asynchronously queued via channel without flush guarantees on window close.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test -- --test-threads=1` | exit 0, all 48 tests pass |
| Clippy | `cd inkwell-app/src-tauri; cargo clippy --all-targets` | exit 0, zero warnings |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/state.rs`
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src-tauri/src/main.rs`
- `inkwell-app/src/js/app.js`

**Out of scope**:
- `inkwell-core` WAL low-level file formatting.

## Git workflow

- Branch: `advisor/022-multi-document-tab-sync`
- Commit per step; message style: `fix(state): <description>`

## Steps

### Step 1: Support multi-document sessions in `AppState`

1. In `inkwell-app/src-tauri/src/state.rs`:
   - Define `pub struct DocumentSession { pub id: String, pub doc: Document, pub pdf_path: Option<PathBuf>, pub pdf_bytes: Arc<Vec<u8>>, pub wal: Option<Sender<WalOp>> }`.
   - Store `pub sessions: Mutex<HashMap<String, DocumentSession>>` and `pub active_session_id: Mutex<Option<String>>` in `AppState`.
2. Add a `switch_document(session_id: String)` Tauri command in `commands.rs`.
3. In `inkwell-app/src/js/app.js` in `switchTab(tabId)`:
   - Call `invoke('switch_document', { sessionId: tabId })` so backend state always matches the active visible tab.

**Verify**: Run `cd inkwell-app/src-tauri; cargo clippy --all-targets` → zero warnings.

### Step 2: Synchronize Undo, Redo, Lasso Deletions, and Duplicates with Rust backend & WAL

1. In `inkwell-app/src/js/app.js`:
   - In `undo()`: for undone stroke creations, invoke `invoke('delete_stroke', { strokeIdStr: op.stroke.id })`; for undone erasures, re-commit strokes to backend.
   - In `redo()`: re-commit strokes for restored creations, and delete strokes for redone erasures.
   - In `deleteSelection()`: call `delete_stroke` for each selected stroke.
   - In `duplicateSelection()` & `pasteClipboard()`: invoke `commit_stroke` with the transformed/new stroke samples.
2. In `inkwell-app/src-tauri/src/commands.rs`:
   - Add `undelete_stroke` or accept explicit stroke IDs during `commit_stroke` so frontend and backend stroke IDs match 1-to-1.

**Verify**: Open a document, draw strokes, delete with lasso, undo, and save: verify saved PDF preserves the exact intended stroke state.

### Step 3: Ensure WAL flush and graceful shutdown on window close

1. In `inkwell-app/src-tauri/src/main.rs`:
   - Register `.on_window_event(|window, event| { if let tauri::WindowEvent::CloseRequested { .. } = event { ... } })`.
   - Iterate all active document sessions, send `WalOp::Close`, and flush pending WAL writes before terminating the process.

**Verify**: Run `cd inkwell; cargo test -- --test-threads=1` → all 48 tests pass.

## Test plan

- Test multi-tab workflow: Open Document A and Document B, draw distinct annotations on each, switch tabs repeatedly, and save both. Confirm neither document contains strokes or pages from the other.
- Test Undo/Redo persistence: Draw stroke, delete it, undo deletion, close and reopen document: stroke must be fully recovered from WAL/saved PDF.
- Test Lasso transform: Move a selection of strokes, save document to PDF, reopen: strokes must render at the new transformed position.

## Done criteria

- [ ] `AppState` tracks document sessions in a `HashMap`
- [ ] `switchTab` calls `switch_document` IPC
- [ ] Undo, Redo, and Lasso operations synchronize with Rust `Document` and WAL
- [ ] `cd inkwell; cargo test -- --test-threads=1` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- If session cleanup on tab close causes orphaned temp files, ensure `close_document` command deletes temporary dropped files and closes the WAL.

## Maintenance notes

- Any future editing tool that creates, modifies, or deletes annotations must funnel through a centralized mutation dispatcher that updates both JS state and backend Rust/WAL state simultaneously.
