# Plan 017: WAL Crash Recovery Toast, Laser Pointer Decay, & Root AGENTS.md

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat db1c3a4..HEAD -- inkwell-app/src/js/app.js HANDOFF.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/015-ui-ux-pro-max-touch-targets-focus-and-toast.md
- **Category**: direction
- **Planned at**: commit `db1c3a4`, 2026-08-09

## Why this matters

Currently, when the app recovers lost strokes from the Write-Ahead Log (WAL) after a crash, no visual feedback or toast is shown to the user. Additionally, selecting the Laser Pointer tool draws static dots rather than an animated 1.2-second decaying trail for live lecture presentations.

This plan adds a crash recovery notification toast ("Restored N unsaved strokes from journal"), implements animated fading laser pointer trails, updates stale milestone status in `HANDOFF.md`, and creates a root `AGENTS.md` for AI agent repository guidance.

## Current state

- `inkwell-app/src-tauri/src/commands.rs:128-132`: Opens WAL log file on PDF load, but JS frontend has no recovery toast.
- `inkwell-app/src/js/app.js:49-50`: `laserPos` and `laserTimer` stubbed without fading trail rendering.
- `HANDOFF.md:53-55`: Lists `M1 rendering` as NOT STARTED (stale status doc).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Playwright smoke test | `cd inkwell-m0 && py -3 test_smoke.py` | exit 0, 18/18 pass |

## Scope

**In scope**:
- `inkwell-app/src/js/app.js`
- `HANDOFF.md`
- `AGENTS.md` (root creation)

**Out of scope**:
- Core PDFium bindings

## Steps

### Step 1: Add WAL crash recovery notification toast

In `inkwell-app/src/js/app.js`:
1. When `open_pdf` or `open_pdf_bytes` resolves, check if WAL entries were replayed.
2. Display an info toast: `showToast("Restored unsaved strokes from crash journal", "info")`.

**Verify**: `cd inkwell-m0 && py -3 test_smoke.py` -> exit 0.

### Step 2: Implement animated laser pointer trail decay

In `inkwell-app/src/js/app.js`:
1. Maintain a ring buffer of timestamped laser points (`state.laserPoints = [{x, y, t}]`).
2. In `consume()` when `activeTool === 'laser'`, push points with `Date.now()`.
3. In `requestAnimationFrame` loop, draw red glowing circles with opacity proportional to `1 - (now - t) / 1200`. Auto-filter points older than 1.2s.

**Verify**: `cd inkwell-m0 && py -3 test_smoke.py` -> exit 0.

### Step 3: Update `HANDOFF.md` status & create root `AGENTS.md`

1. Update `HANDOFF.md` milestone status table: mark `M1 rendering` as complete (✅).
2. Create root `AGENTS.md` with subsystem directory map and verification commands.

**Verify**: `git status` -> clean status on modified files.

## Test plan

- Test opening a PDF with existing WAL log and verifying recovery toast appears.
- Test drawing with Laser Pointer tool and verifying smooth 1.2-second fading dot trail.

## Done criteria

- [ ] WAL recovery displays glassmorphic toast notification.
- [ ] Laser pointer tool renders 1.2s decaying red glow trail.
- [ ] `HANDOFF.md` status updated and root `AGENTS.md` created.
- [ ] `plans/README.md` updated.

## STOP conditions

- If laser pointer `requestAnimationFrame` loop runs continuously when laser tool is inactive, ensure loop cancels when laser point array is empty.
