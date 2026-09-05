# Plan 052: Fix Page Insertion Runtime TypeError and Restore Thumbnail/Compositor Redraw

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
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3f3e8d`, 2026-09-05

## Why this matters

When a user submits the "Insert Page" modal form, `inkwell-app/src/js/main.js:691` invokes `navigation.renderThumbnails(_viewport)`. However, `workspace/navigation.js` does not export `renderThumbnails`; it is defined and exported from `ui/drawers.js`. This causes an uncaught `TypeError: navigation.renderThumbnails is not a function`, which triggers the form's catch block (`Failed to insert page`), aborts execution before `compositor.redrawAll()` can execute, and leaves the UI in a broken state with an un-rendered canvas and an error toast.

Fixing this call to `drawers.renderThumbnails()` ensures the newly inserted page renders immediately, updates the thumbnail sidebar, and completes the page insertion flow cleanly without error.

## Current state

The relevant files and lines:
- `inkwell-app/src/js/main.js` (lines 680–702):
```javascript
      // 5. Execute insertion
      await ipc.insertBlankPage(targetIndex, width, height);
      const newPageInfo = {
        page_index: targetIndex,
        width_pt: width,
        height_pt: height,
        template,
      };
      documentOps.insertPageAtIndex(targetIndex, newPageInfo);
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      navigation.goToPage(targetIndex, 'left', _viewport);
      navigation.renderThumbnails(_viewport);
      compositor.redrawAll();

      const templateName = $('insertTemplateSelect') && $('insertTemplateSelect').selectedOptions[0]
        ? $('insertTemplateSelect').selectedOptions[0].textContent
        : template;
      toast.showToast(`Inserted page ${targetIndex + 1} (${templateName})`, 'success');
    } catch (err) {
      const msg = friendlyError(err);
      if (msg) toast.showToast('Failed to insert page: ' + msg, 'error');
    }
```
- `inkwell-app/src/js/main.js` (line 31):
```javascript
import * as drawers from './ui/drawers.js';
```
- `inkwell-app/src/js/ui/drawers.js` (lines 175–177):
```javascript
export function renderThumbnails() {
  const grid = $('thumbnailGrid');
  if (!grid || !state.pageInfos || !state.pageInfos.length) return;
```

`drawers` is already imported into `main.js`. `renderThumbnails()` in `drawers.js` takes 0 arguments and reads `state.pageInfos` directly.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop App Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all checks pass, 0 errors |
| Workspace Unit Tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all pass |
| Rust Linter | `cd inkwell; cargo clippy --all-targets` | exit 0, zero warnings |

## Scope

**In scope** (the only files you should modify):
- `inkwell-app/src/js/main.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- `inkwell-app/src/js/workspace/navigation.js`
- `inkwell-app/src/js/ui/drawers.js`
- Any Rust crates under `inkwell/`

## Steps

### Step 1: Replace invalid `navigation.renderThumbnails` call with `drawers.renderThumbnails`

In `inkwell-app/src/js/main.js`, locate line 691 inside the `pageInsertForm` submit event listener:

Change:
```javascript
      navigation.goToPage(targetIndex, 'left', _viewport);
      navigation.renderThumbnails(_viewport);
      compositor.redrawAll();
```

To:
```javascript
      navigation.goToPage(targetIndex, 'left', _viewport);
      drawers.renderThumbnails();
      compositor.redrawAll();
```

**Verify**:
`grep -rn "navigation.renderThumbnails" inkwell-app/src/js/` → returns 0 matches.

### Step 2: Add page insertion smoke test in `test_app_smoke.py`

In `inkwell-app/test_app_smoke.py`, add a check within the test suite that dispatches a page insertion via the form or programmatic hook, confirming:
1. `pageInsertForm` submit handler runs without throwing a `TypeError`.
2. `thumbnailGrid` contains the updated card count.
3. Zero console errors are logged in `errors`.

**Verify**:
`cd inkwell-app; py -3 test_app_smoke.py` → exit 0, all checks pass.

## Test plan

- Test: In `inkwell-app/test_app_smoke.py`, trigger page insertion and assert that:
  - `state.pageInfos.length` increments.
  - `#thumbnailGrid .thumb-card` elements match the new count.
  - Zero console errors are recorded.
- Verification command: `cd inkwell-app; py -3 test_app_smoke.py`

## Done criteria

Machine-checkable. ALL must hold:
- [ ] `grep -rn "navigation.renderThumbnails" inkwell-app/src/js/` returns empty.
- [ ] `grep -rn "drawers.renderThumbnails()" inkwell-app/src/js/main.js` returns match.
- [ ] `cd inkwell-app; py -3 test_app_smoke.py` exits 0 with 0 errors.
- [ ] No files outside `inkwell-app/src/js/main.js` and `inkwell-app/test_app_smoke.py` are modified (`git status`).
- [ ] `plans/README.md` status row updated for Plan 052.

## STOP conditions

Stop and report back (do not improvise) if:
- `inkwell-app/src/js/main.js` line 691 does not contain `navigation.renderThumbnails`.
- `drawers.renderThumbnails` is not exported by `inkwell-app/src/js/ui/drawers.js`.

## Maintenance notes

- Any future modular reorganization of UI drawers should preserve `export function renderThumbnails()` or provide a clear public export via an orchestrator module.
