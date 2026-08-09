# Plan 016: Stroke Path2D Object Caching & Non-Blocking Async WAL Disk Sync

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat db1c3a4..HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell-app/src/js/ink.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/014-stroke-canvas-debouncing-and-eraser-reference-error.md
- **Category**: perf
- **Planned at**: commit `db1c3a4`, 2026-08-09

## Why this matters

Currently, `drawStroke()` in `ink.js` re-evaluates 2 levels of Chaikin subdivision and recalculates subsegment Bezier cubics on every single frame during `redrawAll()`. For a document with dozens of strokes, this forces over 12,000 Canvas 2D `fill()` operations per redraw frame. On the Rust backend, `commit_stroke()` performs synchronous disk `fsync` inside `wal.append()` while holding the `doc` lock, stalling Tauri IPC resolution at stylus release.

By caching smoothed `Path2D` vector outlines on stroke completion, `redrawAll()` can render committed strokes in 1 `fill()` call per stroke. On the backend, offloading WAL disk append operations onto a channel or background task prevents disk I/O from blocking stylus release.

## Current state

- `inkwell-app/src/js/ink.js:241-267`: `drawStroke()` performs runtime Chaikin subdivision and subsegment iteration on every render pass.
- `inkwell-app/src-tauri/src/commands.rs:256-258`: `commit_stroke()` calls `wal.append(&WalEntry::Added(stroke))` synchronously on the main IPC command thread.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust workspace tests | `cd inkwell && cargo test --workspace` | exit 0, 46 tests pass |
| Python validator | `py -3 tools/validate.py` | exit 0, 24/24 pass |

## Scope

**In scope**:
- `inkwell-app/src/js/ink.js`
- `inkwell-app/src/js/app.js`
- `inkwell-app/src-tauri/src/commands.rs`

**Out of scope**:
- Core crate mathematical stroke models in `inkwell-core`

## Steps

### Step 1: Pre-calculate and cache `Path2D` outlines on stroke completion

In `inkwell-app/src/js/ink.js`:
1. Add a `getPath2D(stroke)` method on `Ink.Stroke` or `Ink` module.
2. When a stroke is committed on `pointerup`, construct its `Path2D` vector outline and cache it on `stroke._cachedPath2D`.
3. In `Ink.drawStroke(ctx, stroke)`, check if `stroke._cachedPath2D` exists. If present, render with a single `ctx.fill(stroke._cachedPath2D)` call instead of re-evaluating Chaikin subdivision.

**Verify**: `py -3 tools/validate.py` -> exit 0.

### Step 2: Offload WAL disk sync off main IPC thread

In `inkwell-app/src-tauri/src/commands.rs`:
1. Use an asynchronous thread pool or background channel for `wal.append()` in `commit_stroke()` so the IPC command returns immediately after updating memory state.
2. Ensure WAL disk writes maintain write order and error logging.

**Verify**: `cd inkwell && cargo test --workspace` -> 46 tests pass.

## Test plan

- Verify stroke rendering visual fidelity remains identical before and after `Path2D` caching.
- Run integration tests: `cd inkwell && cargo test --workspace` -> exit 0.

## Done criteria

- [ ] `Ink.drawStroke()` uses `stroke._cachedPath2D` when available.
- [ ] `commit_stroke()` IPC response is not delayed by disk `fsync`.
- [ ] `plans/README.md` updated.

## STOP conditions

- If `Path2D` is not supported in a headless test environment, fall back gracefully to standard path generation and report.
