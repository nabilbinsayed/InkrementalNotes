# Milestone 3 Adversarial Challenge Report

**Verdict**: **REQUEST_CHANGES**

---

## 1. Observation

### Verified Baseline Observations
1. **Rust Workspace Tests (`inkwell`)**:
   - Command: `cd "/mnt/Work/Own Programs/InkWell/inkwell" && cargo test --workspace -- --test-threads=1`
   - Result: All 72 tests passed (8 adversarial security, 6 geometry, 26 integration, 6 spatial, 14 tiles in `inkwell-core`; 3 adversarial security, 8 integration in `inkwell-pdf`; 1 doctest), 0 failed, exit code 0.
2. **Rust Workspace Static Analysis (`inkwell`)**:
   - Command: `cd "/mnt/Work/Own Programs/InkWell/inkwell" && cargo check --all-targets`
   - Result: Finished dev profile in 0.14s, 0 warnings, 0 errors, exit code 0.
3. **Existing Desktop App Smoke Tests (`inkwell-app`)**:
   - Command: `cd "/mnt/Work/Own Programs/InkWell/inkwell-app" && uv run --with playwright python3 test_app_smoke.py`
   - Result: 43/43 checks passed, exit code 0.

---

### Adversarial Stress Testing Observations & Discovered Bugs

Adversarial stress harness (`inkwell-app/test_adversarial_m3.py`) executed 25 adversarial test cases across 6 suites.

#### Bug 1: Uncaught `TypeError: toolbar.closeZoomMenu is not a function` in `inkwell-app/src/js/main.js`
- **Location**: `inkwell-app/src/js/main.js`, Line 494:
  ```javascript
  const applyCustomZoom = () => {
    const input = $('inputCustomZoom');
    if (!input || !_viewport) return;
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) {
      const targetZoom = Math.max(0.15, Math.min(10.0, val / 100));
      const stageRect = compositor.getStageRect() || { width: 800, height: 600 };
      _viewport.setZoom(targetZoom, [stageRect.width / 2, stageRect.height / 2], 'left');
      if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
      toolbar.closeZoomMenu(); // <--- Line 494: throws TypeError
    }
  };
  ```
- **Inspection of `inkwell-app/src/js/ui/toolbar.js`**:
  `toolbar.js` does NOT export a function named `closeZoomMenu()`.
- **Runtime Error**:
  When a user enters a custom zoom percentage (e.g. `120`) in `#inputCustomZoom` and clicks `#btnApplyCustomZoom` or presses Enter:
  `Page errors after applying custom zoom: ['toolbar.closeZoomMenu is not a function']`
- **Violation**: Violates AGENTS.md Rule 5 ("No Synthetic Delay or Swallowed Errors: Always trace error root causes") and M3 requirement for zero console errors throughout session.

#### Bug 2: `expandSelectionToWord` Line Bleeding across Multi-Line Text in `inkwell-app/src/js/workspace/text-selection.js`
- **Location**: `inkwell-app/src/js/workspace/text-selection.js`, Lines 308–317:
  ```javascript
  const isWordChar = c => !/[\s\r\n\t.,!?;:()\[\]{}"'—–/\\]/.test(c);

  while (start > 0 && isWordChar(pageData.chars[start - 1].c)) {
    start--;
  }
  while (end < pageData.chars.length - 1 && isWordChar(pageData.chars[end + 1].c)) {
    end++;
  }
  ```
- **Observation**:
  `pageData.chars` stores sequential character objects across lines (e.g., character 12 `'l'` on line 0, immediately followed by character 14 `'S'` on line 1).
  Because the forward and backward loops only check `isWordChar(c)` and do not verify that `pageData.chars[start - 1].line_index === currentLineIndex` / `pageData.chars[end + 1].line_index === currentLineIndex`, double-clicking the last word of a line or the first word of the next line bleeds across the line break and selects characters from the adjacent line (e.g., selecting `"InkWell"` at char 8 expands to `"InkWellSecond"`).
- **Violation**: Violates M1/M3 text selection multi-line boundary requirements and word selection semantics.

#### Bug 3: Test Coverage Gap in `test_app_smoke.py`
- **Location**: `inkwell-app/test_app_smoke.py`
- **Observation**:
  - `T11 (Zoom Controls)` only tests `#btnZoomIn` and `#btnZoomOut` button clicks; it omitted testing the custom zoom percentage input `#inputCustomZoom` + `#btnApplyCustomZoom`, allowing Bug 1 to escape initial smoke suite detection.
  - `T4 (PDF Text Selection)` tests character drag selection and line ranges, but does not assert double-click / `expandSelectionToWord` word boundary isolation.

---

## 2. Logic Chain

1. **Spacebar State Machine & Timing Robustness**:
   - Tested rapid chatter (10x Space keypresses with 15ms duration), key repeat (`repeat: true`), sub-threshold jitter (<2px drag during Space hold), Space hold >= 250ms with no drag, and input field isolation.
   - All spacebar interactions behaved correctly: jitter <2px triggers quick-toggle; hold >=250ms reverts to `toolBefore`; typing in focused input fields does not trigger pan mode.
2. **Zoom Clamping & Coordinate Precision**:
   - `zoomOut()` repeatedly clamps to >= 0.15; `zoomIn()` repeatedly clamps to <= 10.0.
   - Screen-to-world and world-to-screen roundtrip mapping error is < 1e-13.
3. **Root Cause Analysis of Discovered Bugs**:
   - In `main.js:494`, `applyCustomZoom` references `toolbar.closeZoomMenu()`, an unexported symbol. In `toolbar.js`, zoom popover dismissal is handled via `$('zoomMenuPopover').classList.add('hidden')` (or `toolbar.js` should export `closeZoomMenu() { $('zoomMenuPopover')?.classList.add('hidden'); }`).
   - In `text-selection.js:310-316`, `expandSelectionToWord` needs to check `pageData.chars[start - 1].line_index === initialLine` and `pageData.chars[end + 1].line_index === initialLine` to prevent crossing lines.
   - These two bugs are reproducible in production builds and fail the strict console hygiene and tool reliability criteria.

---

## 3. Caveats

- Clippy binary was not pre-installed in the container environment; static analysis was verified via `cargo check --all-targets`.
- Touch targets in tightly clustered toolbars (such as adjacent zoom buttons) share pseudo-element hit boundaries without blocking click dispatch.
- No other caveats.

---

## 4. Conclusion

**Verdict**: **REQUEST_CHANGES**

Milestone 3 cannot be approved until the following two defects and test coverage gaps are remediated:
1. **Fix `toolbar.closeZoomMenu` TypeError in `inkwell-app/src/js/main.js`**:
   - Either export `closeZoomMenu` from `inkwell-app/src/js/ui/toolbar.js` (e.g. `export function closeZoomMenu() { $('zoomMenuPopover')?.classList.add('hidden'); }`), or update `main.js:494` to `$('zoomMenuPopover')?.classList.add('hidden');`.
2. **Fix `expandSelectionToWord` line boundary checking in `inkwell-app/src/js/workspace/text-selection.js`**:
   - Constrain the expansion loops to only include characters where `char.line_index === initialLineIndex`.
3. **Expand `inkwell-app/test_app_smoke.py`**:
   - Add test assertion in `T11` for custom zoom input entry (`#inputCustomZoom` + `#btnApplyCustomZoom`).
   - Add test assertion in `T4` for `expandSelectionToWord` to prevent future multi-line bleeding regressions.

---

## 5. Verification Method

To reproduce and verify these findings:

1. **Reproduce Bug 1 (`applyCustomZoom` TypeError)**:
   ```bash
   cd "/mnt/Work/Own Programs/InkWell/inkwell-app"
   uv run --with playwright python3 -c "
   from playwright.sync_api import sync_playwright
   import pathlib
   ROOT = pathlib.Path('/mnt/Work/Own Programs/InkWell/inkwell-app')
   URL = (ROOT / 'src' / 'index.html').as_uri()
   errors = []
   with sync_playwright() as pw:
       b = pw.chromium.launch(headless=True, args=['--allow-file-access-from-files', '--no-sandbox'])
       pg = b.new_page()
       pg.on('pageerror', lambda e: errors.append(str(e)))
       pg.goto(URL)
       pg.wait_for_timeout(500)
       pg.locator('#btnWelcomeNewNote').click()
       pg.locator('#btnZoomMenu').click()
       pg.locator('#inputCustomZoom').fill('120')
       pg.locator('#btnApplyCustomZoom').click()
       pg.wait_for_timeout(100)
       print('Errors:', errors)
       b.close()
   "
   ```
   *Expected Outcome*: Prints `Errors: ['toolbar.closeZoomMenu is not a function']`.

2. **Reproduce Bug 2 (`expandSelectionToWord` Line Bleed)**:
   ```bash
   cd "/mnt/Work/Own Programs/InkWell/inkwell-app"
   uv run --with playwright python3 test_adversarial_m3.py
   ```
   *Expected Outcome*: Fails on `expandSelectionToWord resolves exact word boundaries` with `w1=InkWellSecond`.
