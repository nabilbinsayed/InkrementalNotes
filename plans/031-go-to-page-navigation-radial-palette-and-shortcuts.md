# Plan 031: Precision Navigation Suite: Direct Go-to-Page Modal (Ctrl+G), Stylus Barrel Actions & Comprehensive Shortcuts Matrix

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8337e2c..HEAD -- inkwell-app/src/js/app.js inkwell-app/src/js/viewport.js inkwell-app/src/index.html inkwell-app/src/styles.css`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/027-page-lifecycle-layout-sync-and-insertion-dialog.md
- **Category**: ux / dx
- **Planned at**: commit `8337e2c`, 2026-08-17

## Why this matters

Navigating large PDFs requires quick keyboard and numeric access. Currently, clicking the header page indicator opens the side thumbnail drawer instead of providing a direct page jump input box. Navigating to page 280 requires scrolling through a long list or repeated clicks. Furthermore, stylus hardware barrel buttons (secondary button for eraser/lasso) and touch gestures (two-finger tap for undo, three-finger tap for redo) are not natively wired, and productivity hotkeys (`Ctrl+T` new tab, `Ctrl+W` close tab, `Ctrl+G` go to page, `Ctrl+0` fit, `?` shortcuts cheat sheet) are missing or incomplete.

## Current state

- `inkwell-app/src/js/app.js:3575`: `btnPageDropdown` is wired directly to `toggleDrawer('thumbnails')`.
- `inkwell-app/src/js/viewport.js:293-324`: Stylus pointerdown does not map hardware secondary barrel button (`e.buttons === 32` or `e.button === 2`) to instantaneous eraser or selection mode.
- `inkwell-app/src/js/app.js:2639-2655`: Hotkeys lack tab shortcuts (`Ctrl+T`, `Ctrl+W`), page jump (`Ctrl+G`), and keyboard discovery overlay.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 checks pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, all tests pass |
| Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |

## Scope

**In scope** (the only files you should modify):
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src/index.html`
- `inkwell-app/src/styles.css`

**Out of scope** (do NOT touch):
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-core`

## Git workflow

- Branch: `advisor/031-navigation-shortcuts-stylus`
- Commit message: `feat(nav): add direct page jump modal, stylus barrel shortcuts, and hotkey matrix`

## Steps

### Step 1: Implement Direct Numeric Go-to-Page Popover & `Ctrl+G` Modal in `app.js` and `index.html`

1. In `inkwell-app/src/index.html`, add a `#goToPageModal` with:
   - Numeric input box `#goToPageInput` (min: 1, max: totalPages).
   - "Go" submit button and quick jump buttons (First Page, Last Page).
2. In `inkwell-app/src/js/app.js`:
   - Clicking `pageNumDisplay` or pressing `Ctrl+G` / `Cmd+G` opens `#goToPageModal` with input focused and pre-selected.
   - Pressing `Enter` parses the input, clamps to `[1, totalPages]`, closes the modal, and calls `goToPage(target - 1, 'left')`.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0

### Step 2: Wire Stylus Barrel Button and Gesture Engine in `viewport.js` and `ink.js`

1. In `inkwell-app/src/js/viewport.js`:
   - Detect stylus barrel button (`e.pointerType === 'pen' && (e.buttons === 32 || e.button === 2)`):
     - Automatically switch tool to `eraser` while barrel button is pressed, restoring previous tool on release.
   - Detect 2-finger single tap on canvas stage: trigger `undo()`.
   - Detect 3-finger single tap on canvas stage: trigger `redo()`.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0, 18/18 checks pass

### Step 3: Complete Keyboard Shortcut Matrix and Help Modal in `app.js`

1. In `inkwell-app/src/js/app.js`, handle the following shortcuts:
   - `Ctrl+T`: Create new tab or open file
   - `Ctrl+W`: Close active tab
   - `Ctrl+Tab` / `Ctrl+Shift+Tab`: Switch to next / previous tab
   - `Ctrl+G`: Open Go to Page modal
   - `Ctrl+1` / `Ctrl+2` / `Ctrl+0`: 100% Zoom, 200% Zoom, Fit to Window
   - `P` (Pen), `H` (Highlighter), `E` (Eraser), `L` (Lasso), `S` (Select), `Space` (Hold to Pan)
   - `?` or `F1`: Toggle Keyboard Shortcuts cheat sheet modal `#shortcutsModal`.
2. In `inkwell-app/src/index.html` and `styles.css`, build the `#shortcutsModal` listing all key combinations grouped by category.

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → exit 0

## Test plan

- Press `Ctrl+G`, type "2", press `Enter`; verify canvas scrolls smoothly to page 2.
- Press `Ctrl+T`; verify a new document tab is created.
- Press `Ctrl+W`; verify the active tab closes and switches to the previous tab.
- Press `?`; verify the shortcuts cheat sheet modal displays with clean styling.

## Done criteria

- [ ] `Ctrl+G` opens Go to Page modal and jumps directly to entered page index
- [ ] Stylus barrel button activates temporary eraser mode seamlessly
- [ ] Tab management shortcuts (`Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`) function smoothly
- [ ] Keyboard shortcut cheat sheet modal (`?`) is accessible and responsive
- [ ] All smoke and unit tests pass

## STOP conditions

- If `Ctrl+T` or `Ctrl+W` conflicts with browser defaults when running in web mode, ensure `e.preventDefault()` is invoked only when target is within InkWell window.

## Maintenance notes

- Any future tools added to InkWell should register their default keybinding in this hotkey matrix.
