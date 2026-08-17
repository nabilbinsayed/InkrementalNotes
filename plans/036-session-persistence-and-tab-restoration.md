# Plan 036: Session State Persistence & Multi-Tab Crash Restoration

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell-app/src/js/app.js inkwell-app/src-tauri/src/commands.rs inkwell-app/src-tauri/src/state.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/033-universal-wal-durability-and-crash-recovery.md
- **Category**: feature / stability
- **Planned at**: commit `8337e2c`, 2026-08-18

## Why this matters

When users work across multiple PDF tabs simultaneously, closing the application or suffering an unexpected power interruption leaves the next application launch in a default blank state. The user must manually remember and re-open each individual document file path to trigger WAL crash replay. Persisting the active tab list, active tab index, zoom levels, and scroll positions in client storage (`localStorage`) allows Inkwell to seamlessly re-hydrate all open tabs upon boot, automatically replaying their respective WAL journals and offering a "Restore previous session" prompt.

## Current state

- `inkwell-app/src/js/app.js:5250-5300`: `documentTabs` array is stored only in volatile JS memory.
- On page reload or app restart, `init()` opens with a blank whiteboard or default state without checking for previously opened tabs.
- `inkwell-app/src-tauri/src/commands.rs:953-1005`: `switch_document_session` and `close_document_session` manage in-memory sessions, but no metadata index is persisted to disk.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Playwright Smoke Tests | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| E2E Test Suite | `cd e2e-tests; py -3 run_all.py` | exit 0, 272/272 pass |

## Scope

**In scope**:
- `inkwell-app/src/js/app.js`

**Out of scope**:
- `inkwell-core`
- `inkwell-pdf`

## Git workflow

- Branch: `advisor/036-session-persistence`
- Commit message: `feat(session): persist multi-tab session list and automatically restore previous tabs on boot`

## Steps

### Step 1: Save Session Metadata on Tab Changes in `app.js`

1. Create `persistSessionState()`:
   ```javascript
   function persistSessionState() {
     const sessionData = {
       activeTabIndex,
       tabs: documentTabs.map(t => ({
         id: t.id,
         title: t.title,
         pathStr: t.pathStr,
         leftSheet: t.leftSheet,
         rightSheet: t.rightSheet,
         zoom: t.zoom,
         panX: t.panX,
         panY: t.panY,
         splitMode: t.splitMode,
       })),
     };
     localStorage.setItem('inkwell_active_session', JSON.stringify(sessionData));
   }
   ```
2. Call `persistSessionState()` on tab addition, tab close, tab switch, and document save.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` -> exit 0.

### Step 2: Restore Previous Session on App Boot in `app.js`

1. In `init()`:
   - Check `localStorage.getItem('inkwell_active_session')`.
   - If previous tabs exist, restore tabs sequentially:
     - For tabs with `pathStr`, call `invoke('open_pdf', { pathStr })` which automatically replays any uncommitted WAL entries from a previous crash.
     - Restore scroll position and active tab selection.
   - If a crash is detected, display a discreet recovery banner: *"Restored previous session with N tabs."*

**Verify**: `cd e2e-tests; py -3 run_all.py` -> exit 0.

## Test plan

- Test opening 3 PDF tabs, making annotations, killing process, and restarting: verify all 3 tabs reload and show restored annotations from WAL.
- Test closing all tabs: verify clean state on relaunch.

## Done criteria

- [ ] Multi-document tabs are persisted and restored automatically across restarts.
- [ ] Crash WAL journals for all tabs are replayed cleanly on startup.
- [ ] All tests pass.
