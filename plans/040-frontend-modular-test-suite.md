# Plan 040: Frontend Modular Test Suite & E2E Verification for `inkwell-app`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aef1b6a..HEAD -- inkwell-app/test_app_smoke.py inkwell-app/src/index.html`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/038-modular-frontend-migration-and-app-cleanup.md
- **Category**: tests
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

The repository currently relies on `inkwell-m0/test_smoke.py` for end-to-end verification, but that test suite targets the initial M0 prototype stage rather than the actual production Tauri frontend in `inkwell-app/src/index.html`. With the cutover to the modular ES architecture, an automated headless Playwright test suite for `inkwell-app` is essential to verify that ES modules resolve cleanly, all tool activations (pen, highlighter, eraser, text, shapes, text-selection) work without runtime exceptions, drawer transitions complete, and keyboard shortcuts operate properly.

## Current state

- `inkwell-m0/test_smoke.py`:
  Drives CDP synthetic pen events against `inkwell-m0/src/index.html`. All 18 checks pass.
- `inkwell-app/`:
  Lacks a dedicated automated Playwright test runner to verify `inkwell-app/src/index.html` and its modular ES scripts.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Run App Smoke | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all checks pass |
| Run M0 Smoke | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |

## Scope

**In scope**:
- `inkwell-app/test_app_smoke.py` (CREATE)

**Out of scope**:
- Modifying core math algorithms in `inkwell-core`.

## Git workflow

- Branch: `advisor/040-frontend-test-suite`
- Commit style: `test(frontend): <description>`

## Steps

### Step 1: Create `inkwell-app/test_app_smoke.py`
Create a Playwright test runner that:
1. Launches headless Chromium with device scale factor = 1.
2. Navigates to `file://.../inkwell-app/src/index.html`.
3. Asserts zero console errors and zero uncaught exceptions on boot.
4. Verifies that all ES modules (`compositor`, `toolManager`, `drawers`, `viewport`) initialize cleanly on `window`.
5. Dispatches synthetic pointer events on `#wet` for:
   - Pen tool stroke drawing & wet/dry canvas rendering.
   - Tool switching: Pen -> Highlighter -> Eraser -> TextSelect -> Shape.
   - Drawer toggle buttons: Thumbnails, Outline, Search, Settings.
   - Command palette trigger (`Ctrl+K` / `Ctrl+Shift+P`).
6. Verifies that no uncaught promise rejections or missing module errors occurred throughout the session.

**Verify**: `cd inkwell-app; py -3 test_app_smoke.py` → exit 0

## Test plan

- Execute `cd inkwell-app; py -3 test_app_smoke.py` and confirm all modular app checks pass.
- Execute `cd inkwell-m0; py -3 test_smoke.py` and confirm legacy M0 checks continue to pass.

## Done criteria

- [ ] `inkwell-app/test_app_smoke.py` exists and passes with exit code 0.
- [ ] Zero console errors and zero console warnings during full UI exercise.
- [ ] `plans/README.md` status row updated to DONE.

## STOP conditions

- If ES module imports fail under file:// protocol in Playwright without a local static server, launch a lightweight python `http.server` in the background during test execution.

## Maintenance notes

- Add new UI components or interactive tools to the smoke test verification list as they are introduced.
