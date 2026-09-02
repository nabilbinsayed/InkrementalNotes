# Review & Adversarial Challenge Report — Milestone 1

**Reviewer**: reviewer_m1_2 (reviewer, critic)  
**Target Work Product**: worker_m1 (Milestone 1: Frontend Tool Repair & Interaction Polish)  
**Date**: 2026-09-02  
**Verdict**: **REQUEST_CHANGES**  

---

## 1. Observation

1. **Test Executions**:
   - `test_app_smoke.py`: 20/20 checks passed (exit code 0).
   - `test_m1_interactive.py`: 19/19 checks passed (exit code 0).
   - `cargo test --workspace -- --test-threads=1`: 72/72 unit/integration tests passed (exit code 0).
   - `cargo check --all-targets`: Passed cleanly with zero warnings/errors.

2. **Source Code Inspection**:
   - In `inkwell-app/src/js/tools/tool-manager.js:92-108`:
     ```javascript
     export function setTool(toolName, { isUserSwitch = true } = {}) {
       if (!toolName) return;
       const tool = toolName.toLowerCase();
       
       if (isUserSwitch && tool !== 'pan' && state.activeTool && state.activeTool !== 'pan' && state.activeTool !== tool) {
         state.lastActiveTool = state.activeTool;
       }

       if (tool === 'ruler') {
         state.activeTool = 'ruler';
         state.shapeKind = 'line';
       } else if (tool === 'rect' || tool === 'ellipse') {
         state.activeTool = tool;
         state.shapeKind = tool;
       } else {
         state.activeTool = tool;
       }
     ```
     When `toolManager.setTool('textSelect')` is called, `toolName.toLowerCase()` produces `'textselect'`. The `else` branch sets `state.activeTool = 'textselect'`.

   - In `inkwell-app/src/js/main.js`:
     - Line 226: `if (state.activeTool === 'textSelect' && state.selectedTextString && textSelection.copySelectedPdfText())`
     - Line 663: `if (sel && sel.text && sel.text.trim() && (state.activeTool === 'textSelect'))`
     - Line 715: `if (tool !== 'textSelect') { const pop = $('textSelectionPopover'); if (pop) pop.classList.add('hidden'); }`
     - Line 742: `} else if (tool === 'textSelect') {` (in `pointerdown`)
     - Line 817: `} else if (tool === 'textSelect') {` (in `pointermove`)
     - Line 851: `} else if (tool === 'textSelect') {` (in `pointerup`)
     - Line 953: `if (payload && (payload.tool === 'textSelect' || payload.tool === 'highlighter'))`

   - In `inkwell-app/src/js/ui/toolbar.js:32-44`:
     ```javascript
     const toolButtonMap = {
       pen: $('btnDockPen'),
       highlighter: $('btnDockHighlighter'),
       eraser: $('btnDockEraser'),
       lasso: $('btnDockLasso'),
       pan: $('btnDockPan'),
       laser: $('btnDockLaser'),
       rect: $('btnDockShapes'),
       ellipse: $('btnDockShapes'),
       ruler: $('btnDockShapes'),
       text: $('btnDockText'),
       textSelect: $('btnDockTextSelect'),
     };
     ```
     `toolButtonMap['textselect']` evaluates to `undefined`.

3. **Behavioral Empirical Test Output**:
   Running a Playwright canvas drag test with the Text Select tool activated via UI:
   ```
   activeTool after setTool('textSelect'): 'textselect'
   btnDockTextSelect has 'active' class: False
   textSelection after mouse drag on wet canvas: None
   textSelectionPopover is hidden: True
   ```

---

## 2. Logic Chain

1. When a user clicks `#btnDockTextSelect` or triggers `tool.textSelect`, `toolManager.setTool('textSelect')` is invoked.
2. In `tool-manager.js`, `setTool` lowercases the input string to `'textselect'` and assigns `state.activeTool = 'textselect'`.
3. In `main.js`, all pointer handlers (`pointerdown` line 742, `pointermove` line 817, `pointerup` line 851) strictly test `tool === 'textSelect'`. Because `'textselect' !== 'textSelect'`, pointer events on the canvas are completely ignored for text selection during runtime.
4. In `toolbar.js`, `updateToolbarUI` indexes `toolButtonMap[state.activeTool]`. Because `toolButtonMap` only has the key `textSelect`, `btnDockTextSelect` never receives the `.active` CSS class.
5. In `main.js`, `updateTextSelectionPopover` checks `state.activeTool === 'textSelect'`, causing the text selection popover to permanently remain hidden (`.classList.add('hidden')`).
6. The test `test_m1_interactive.py` failed to catch this defect because it bypassed `main.js`'s pointer pipeline and directly injected `state.textSelection` via JavaScript `import('./js/workspace/text-selection.js')`.
7. Therefore, Text Selection is broken in interactive user operation on the canvas.

---

## 3. Caveats

- Rust core workspace (`inkwell-core`, `inkwell-pdf`, `inkwell-wal`) builds and passes all 72 tests cleanly with zero regressions.
- Spacebar quick-toggle (<250ms), Spacebar hold-to-pan (>=250ms), Canvas context menu, Radial menu, and Command Palette keyboard navigation are otherwise properly designed and robust.
- The defect is isolated to tool name casing normalization between `tool-manager.js`, `state.js`, `toolbar.js`, and `main.js`.

---

## 4. Conclusion

**Verdict: REQUEST_CHANGES**

### Required Changes for worker_m1:
1. **Normalize `textSelect` casing in `tool-manager.js`**:
   In `inkwell-app/src/js/tools/tool-manager.js`:
   ```javascript
   export function setTool(toolName, { isUserSwitch = true } = {}) {
     if (!toolName) return;
     let tool = toolName.toLowerCase();
     if (tool === 'textselect') tool = 'textSelect';
     ...
   ```
   Or maintain canonical casing matching `TOOL_NAMES`.
2. **Update `toolbar.js` and `main.js`**:
   Ensure `state.activeTool` consistently uses `'textSelect'` across `tool-manager.js`, `state.js`, `main.js`, `toolbar.js`, and `overlays.js`.
3. **Verify Canvas Mouse Drag Selection**:
   Add an end-to-end interactive assertion in `test_m1_interactive.py` that clicks `#btnDockTextSelect`, drags the mouse across `#wet`, and asserts `state.textSelection !== null` and `#textSelectionPopover` is visible without manually injecting state.

---

## 5. Verification Method

1. **Verify Casing & Dock Activation**:
   ```bash
   uv run --with playwright python3 - << 'EOF'
   import pathlib
   from playwright.sync_api import sync_playwright

   ROOT = pathlib.Path("/mnt/Work/Own Programs/InkWell/inkwell-app")
   URL = (ROOT / "src" / "index.html").as_uri()

   with sync_playwright() as pw:
       b = pw.chromium.launch(headless=True, args=["--allow-file-access-from-files", "--no-sandbox"])
       pg = b.new_page()
       pg.goto(URL)
       pg.wait_for_timeout(500)
       pg.locator("#btnDockTextSelect").click(force=True)
       active = pg.evaluate("window.state.activeTool")
       btn_active = pg.evaluate("document.getElementById('btnDockTextSelect').classList.contains('active')")
       print(f"activeTool: '{active}', button active class: {btn_active}")
       assert active == "textSelect" and btn_active is True
       b.close()
   EOF
   ```
   *Expected outcome*: `activeTool: 'textSelect', button active class: True`.

2. **Verify App Smoke & Interactive Suites**:
   ```bash
   cd /mnt/Work/Own\ Programs/InkWell/inkwell-app
   uv run --with playwright python3 test_app_smoke.py
   uv run --with playwright python3 test_m1_interactive.py
   ```
   *Expected outcome*: 100% tests pass.

3. **Verify Rust Test Suite**:
   ```bash
   cd /mnt/Work/Own\ Programs/InkWell/inkwell
   cargo test --workspace -- --test-threads=1
   ```
   *Expected outcome*: All 72 tests pass.
