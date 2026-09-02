# Milestone 1 Adversarial Challenge Report

**Challenger**: challenger_m1_2 (critic / specialist)  
**Target Milestone**: Milestone 1: Frontend Tool Repair & Interaction Polish  
**Working Directory**: `/mnt/Work/Own Programs/InkWell/.agents/challenger_m1_2`  
**Date**: 2026-09-02  
**Verdict**: **REQUEST_CHANGES**  

---

## 1. Observation

Adversarial stress-testing of Milestone 1 components was executed via Playwright in `test_m1_challenger_stress.py`. Out of 36 rigorous checks, 32 passed and 4 critical failure modes were empirically confirmed in the PDF text selection and clipboard copying pipeline:

1. **Tool Casing Desynchronization in `tool-manager.js`**:
   - `inkwell-app/src/js/tools/tool-manager.js` (lines 4–6, 94, 107):
     ```javascript
     export const TOOL_NAMES = [
       'pen', 'highlighter', 'eraser', 'lasso', 'ruler', 'rect', 'ellipse', 'laser', 'text', 'textSelect', 'pan'
     ];
     ...
     export function setTool(toolName, { isUserSwitch = true } = {}) {
       if (!toolName) return;
       const tool = toolName.toLowerCase();
       ...
       state.activeTool = tool;
     ```
     `setTool('textSelect')` applies `.toLowerCase()`, forcing `state.activeTool` to lowercase `'textselect'`.

2. **Inactive Text Selection Dock Button in `toolbar.js`**:
   - `inkwell-app/src/js/ui/toolbar.js` (lines 43, 52–53):
     ```javascript
     const toolButtonMap = {
       ...
       text: $('btnDockText'),
       textSelect: $('btnDockTextSelect'),
     };
     ...
     const activeBtn = toolButtonMap[activeTool];
     if (activeBtn) activeBtn.classList.add('active');
     ```
     When `activeTool` is `'textselect'`, `toolButtonMap['textselect']` evaluates to `undefined`. The Text Selection dock button `#btnDockTextSelect` never receives the `.active` class when clicked.

3. **Complete Failure of Canvas Text Drag Selection in `main.js`**:
   - `inkwell-app/src/js/main.js` (lines 713, 715, 742, 817, 851):
     ```javascript
     const tool = state.activeTool || 'pen';
     if (tool !== 'textSelect') {
       const pop = $('textSelectionPopover');
       if (pop) pop.classList.add('hidden');
     }
     ...
     } else if (tool === 'textSelect') {
       // Hit-testing and selection anchor setup
     }
     ...
     } else if (tool === 'textSelect') {
       // Drag selection range computation
     }
     ...
     } else if (tool === 'textSelect') {
       // Selection commit and popover display
     }
     ```
     Because `tool` is `'textselect'`, all strict equality checks `tool === 'textSelect'` evaluate to `false`. Pointerdown, pointermove, and pointerup handlers on `#wet` canvas bypass text selection entirely. Canvas mouse dragging fails to select text (`state.textSelection` remains `null`).

4. **Permanent Invisibility of Text Selection Popover**:
   - `inkwell-app/src/js/main.js` (lines 662–663):
     ```javascript
     const sel = state.textSelection;
     if (sel && sel.text && sel.text.trim() && (state.activeTool === 'textSelect')) {
       ...
       pop.classList.remove('hidden');
     } else {
       pop.classList.add('hidden');
     }
     ```
     Because `state.activeTool` is `'textselect'`, `state.activeTool === 'textSelect'` evaluates to `false`. `#textSelectionPopover` remains permanently hidden in production runtime.

5. **Clipboard Text Copy (`Ctrl+C`) Failure**:
   - `inkwell-app/src/js/main.js` (lines 225–232):
     ```javascript
     execute: () => {
       if (state.activeTool === 'textSelect' && state.selectedTextString && textSelection.copySelectedPdfText()) {
         return;
       }
       if (clipboard.copySelection()) {
         toast.showToast('Copied to clipboard', 'info');
       }
     }
     ```
     Because `state.activeTool === 'textSelect'` evaluates to `false`, pressing `Ctrl+C` with selected text falls through to `clipboard.copySelection()` (which is intended for vector stroke lasso selections) and fails to copy the selected PDF text to the clipboard.

6. **Worker Test False-Positive Root Cause**:
   - In `test_m1_interactive.py`, tests manually called `computeTextSelectionRanges` and manually assigned `window.state.textSelection = sel;`, completely bypassing the canvas pointer event routing, toolbar active styling, text popover visibility, and `Ctrl+C` keyboard shortcut handlers.

---

## 2. Logic Chain

1. `tool-manager.js:94` transforms tool inputs with `toolName.toLowerCase()`, storing `'textselect'` into `state.activeTool`.
2. Downstream consumer modules (`main.js` and `toolbar.js`) explicitly use camelCase `'textSelect'` in `tool === 'textSelect'` and `toolButtonMap['textSelect']`.
3. In JavaScript, `'textselect' === 'textSelect'` evaluates to `false`.
4. Therefore, when a user activates the Text Selection tool:
   - The UI button never highlights as active (`toolbar.js:52`).
   - Pointer events on the canvas do not initiate text hit-testing (`main.js:742`).
   - Dragging across text does not highlight characters (`main.js:817`).
   - Releasing the pointer does not display the popover menu (`main.js:663`).
   - Pressing `Ctrl+C` does not invoke `textSelection.copySelectedPdfText()` (`main.js:226`).
5. Spacebar toggling, spring keys, radial menu actions/clamping, and command palette boundary navigation (ArrowUp wrap on index 0, ArrowDown wrap on last index, query filtering, and empty search robustness) are functioning properly.

---

## 3. Caveats

1. **Rust Core Tests**: All 72 tests across `inkwell-core`, `inkwell-pdf`, `inkwell-wal`, `tiles`, and `spatial` pass with 0 failures and 0 warnings. The defect is strictly in the frontend JS tool casing contract.
2. **Spacebar State Machine**: Spacebar quick-toggling (<250ms), hold-to-pan (>=250ms), window blur recovery (`cancelSpringKeys`), and spring key 'e' temporary toggling are robust and verified across rapid 10-tap oscillations.
3. **Radial Menu & Command Palette**: Radial menu 6-slot circular dial, edge clamping, Escape dismissal, outside click dismissal, command palette wrap-around boundaries, and query filtering are fully verified and robust.

---

## 4. Conclusion

**Verdict: REQUEST_CHANGES**

Milestone 1 cannot be approved in its current state due to the blocking `textSelect` casing bug that disables PDF text selection, the selection popover, and text clipboard copying.

### Required Actions for Worker:
1. **Unify Tool Identifier Casing**:
   - In `inkwell-app/src/js/tools/tool-manager.js`:
     Preserve the canonical tool identifier (e.g., using `const canonical = TOOL_NAMES.find(t => t.toLowerCase() === toolName.toLowerCase()) || tool.toLowerCase();` and setting `state.activeTool = canonical;`) OR ensure all consumers across `main.js`, `toolbar.js`, and `state.js` consistently use `'textselect'`.
   - In `inkwell-app/src/js/ui/toolbar.js`:
     Ensure `toolButtonMap` matches the exact string casing of `state.activeTool` (or add `'textselect': $('btnDockTextSelect')`).
   - In `inkwell-app/src/js/main.js`:
     Ensure lines 226, 663, 715, 742, 817, 851, and 953 match the tool string casing.
2. **Upgrade Test Suite**:
   - Update `test_m1_interactive.py` to drive real mouse drag pointer events on `#wet` canvas, verify `#btnDockTextSelect.active`, verify `#textSelectionPopover` unhides, and verify `Ctrl+C` copies text to clipboard.

---

## 5. Verification Method

To independently verify the defects and validate subsequent fixes:

1. **Run the Challenger Stress Test Harness**:
   ```bash
   cd "/mnt/Work/Own Programs/InkWell/inkwell-app"
   uv run --with playwright python3 test_m1_challenger_stress.py
   ```
   *Current Outcome*: Fails 4 checks (2.1, 2.2, 2.3, 2.4).  
   *Expected Outcome after Fix*: All 36 checks pass (36/36).

2. **Run the Standard Smoke and Interactive Suites**:
   ```bash
   cd "/mnt/Work/Own Programs/InkWell/inkwell-app"
   uv run --with playwright python3 test_app_smoke.py
   uv run --with playwright python3 test_m1_interactive.py
   ```

3. **Run Rust Workspace Tests**:
   ```bash
   cd "/mnt/Work/Own Programs/InkWell/inkwell"
   cargo test --workspace -- --test-threads=1
   ```
