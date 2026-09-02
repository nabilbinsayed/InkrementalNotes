# Handoff Report — Frontend Canvas Tools, Interaction Mechanics & State Management Survey (R2)

**Explorer**: explorer_survey_2  
**Target Milestone**: R2: Tool Repair & Interaction Polish  
**Date**: 2026-09-02  
**Scope**: Frontend tools, interaction mechanics, and state management in `inkwell-app/src/` (`js/core/`, `js/tools/`, `js/render/`, `js/ui/`, `js/workspace/`, `js/main.js`, `js/viewport.js`, `js/ink.js`, `index.html`) and backend bridge coordination (`commands.rs`, `text.rs`).

---

## Executive Summary

A comprehensive, read-only architectural survey of the InkWell frontend interaction engine was conducted across all toolchains, keyboard shortcuts, canvas rendering pipelines, and state coordination bridges. Six critical bugs and architectural gaps were identified:
1. **Spacebar Quick-Toggle & Pan Failure**: Spacebar currently only acts as a naive spring key returning to the same active tool on release (no toggle to previously used tool), left-click dragging when in Pan mode is completely unhandled (canvas drag does nothing), default browser scrolling is unprevented, and focus loss causes permanent pan mode lockups.
2. **Text Selection Async Race Condition & Character Indexing Bug**: Text drag-selection drops on pointermove due to unawaited asynchronous `ensurePageTextData` promise resolution, and character slicing in `computeTextSelectionRanges` is offset on multi-line text because Rust's `PageTextData` omits newline characters while JS slices by raw `char_index`.
3. **Context Menu Event Registration Gap**: Right-click context menu (`showContextMenu`) is defined in `js/ui/context-menu.js` but no `contextmenu` event listener is attached to the canvas or document.
4. **Radial Menu Query Selector Mismatch**: `js/ui/radial-menu.js` queries `.radial-slot` while `index.html` marks elements as `.radial-item`, leaving radial tool buttons dead.
5. **Command Palette Keyboard Navigation Absence**: `js/ui/command-palette.js` lacks keydown handlers for ArrowUp/Down and Enter navigation.
6. **Tool History Tracking Gap**: `toolManager.setTool()` does not track `state.lastActiveTool` across explicit user tool selections, preventing two-tool quick toggling.

Detailed observations, logic chains, recommended fix strategies, and verification methods are documented below.

---

## 1. Observations

### 1.1 Spacebar & Pan Mechanics

* **Obs 1.1.1 — Naive Spring Key Handler**: In `inkwell-app/src/js/tools/tool-manager.js` (lines 153–175):
  ```js
  export function handleSpringKeyDown(key) {
    if (state.springKey) return;
    if (key === 'e' || key === 'E') {
      state.springKey = 'e';
      state.prevTool = state.activeTool;
      setTool('eraser');
    } else if (key === ' ' || key === 'Space') {
      state.springKey = 'space';
      state.prevTool = state.activeTool;
      setTool('pan');
    }
  }

  export function handleSpringKeyUp(key) {
    if (!state.springKey) return;
    if ((key === 'e' || key === 'E') && state.springKey === 'e') {
      state.springKey = null;
      setTool(state.prevTool || 'pen');
    } else if ((key === ' ' || key === 'Space') && state.springKey === 'space') {
      state.springKey = null;
      setTool(state.prevTool || 'pen');
    }
  }
  ```
* **Obs 1.1.2 — Missing Left-Click Canvas Panning**: In `inkwell-app/src/js/main.js` (lines 687–740, `attachPointerHandlers`):
  ```js
  if (tool === 'pen' || tool === 'highlighter') {
    penTool.onPenDown(e, ptWorld, pane, _viewport);
  } else if (tool === 'eraser') {
    eraserTool.onEraserDown(e, ptWorld, pane, _viewport);
  } else if (tool === 'lasso') {
    lassoTool.onLassoDown(e, ptWorld, screenPt, pane, _viewport);
  } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler') {
    shapesTool.onShapeDown(e, ptWorld, pane, _viewport);
  } else if (tool === 'laser') {
    laserTool.onLaserDown(e, ptWorld, pane, _viewport);
  } else if (tool === 'text') {
    textTool.onTextToolClick(e, ptWorld, pane, _viewport);
  } else if (tool === 'textSelect') {
    ...
  }
  ```
  When `tool === 'pan'`, no handler branch executes in `pointerdown`, `pointermove`, or `pointerup`.
* **Obs 1.1.3 — Viewport Panning Limited to Middle Click**: In `inkwell-app/src/js/viewport.js` (lines 430–437 & 485–494):
  ```js
  if (e.button === 1) { // middle button only
    e.preventDefault();
    this.isPanning = true;
    this.lastPanPt = [e.clientX, e.clientY];
    if (element) {
      try { element.setPointerCapture(e.pointerId); } catch (_) {}
    }
  }
  ```
  Left-click (`e.button === 0`) does not initiate panning in `ViewportManager`.
* **Obs 1.1.4 — Missing Spacebar Default Prevention**: In `inkwell-app/src/js/main.js` (lines 808–820):
  ```js
  window.addEventListener('keydown', e => {
    const isTyping = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (isTyping) return;

    // Spring-loaded modifier keys (e.g. holding 'e' or space)
    toolManager.handleSpringKeyDown(e.key);

    const cmd = commandsModule.commands.findMatchingShortcut(e);
    if (cmd) {
      e.preventDefault();
      commandsModule.commands.execute(cmd.id);
    }
  });
  ```
  Spacebar is not a command shortcut in `commands.js`, so `e.preventDefault()` is not executed, causing browser viewport scrolling.
* **Obs 1.1.5 — Lack of Blur Recovery**: No `window.addEventListener('blur', ...)` exists to reset spring key states when the window loses focus while holding Spacebar.

---

### 1.2 Text Selection & PDF Text Layer

* **Obs 1.2.1 — Async Drag Drop in Pointerdown**: In `inkwell-app/src/js/main.js` (lines 710–739):
  ```js
  } else if (tool === 'textSelect') {
    const pageCoord = _viewport.worldToPage(ptWorld[0], ptWorld[1]);
    const now = Date.now();
    textSelection.ensurePageTextData(pageCoord.sheet).then(data => {
      if (!data) return;
      const hit = textSelection.findCharAndOffsetAtPageCoord(pageCoord.sheet, pageCoord.px, pageCoord.py);
      if (hit) {
        ...
        state.isSelectingText = true;
        state.textSelectAnchor = { sheet: pageCoord.sheet, charIndex: hit.charIndex, time: now, clickCount: 1 };
        state.textSelection = textSelection.computeTextSelectionRanges(pageCoord.sheet, hit.charIndex, hit.charIndex);
        ...
      }
    });
  }
  ```
  `ensurePageTextData` returns a Promise microtask or IPC invoke. Pointermove events fire before `then()` runs, seeing `state.isSelectingText === false`, causing mouse drags to fail.
* **Obs 1.2.2 — Character Index vs Array Slicing Discrepancy**:
  In `inkwell/crates/inkwell-pdf/src/text.rs` (lines 206–224):
  ```rust
  if is_newline {
      if !current_line.is_empty() {
          line_groups.push(std::mem::take(&mut current_line));
      }
  } else {
      current_line.push(idx);
  }
  ```
  Newline characters are omitted from `all_chars` in `PageTextData`.
  In `inkwell-app/src/js/workspace/text-selection.js` (lines 244–248):
  ```js
  const minIdx = Math.max(0, Math.min(startCharIdx, endCharIdx));
  const maxIdx = Math.min(pageData.chars.length - 1, Math.max(startCharIdx, endCharIdx));
  const selectedChars = pageData.chars.slice(minIdx, maxIdx + 1);
  ```
  `minIdx` and `maxIdx` are character index IDs, not array indices into `pageData.chars`. After any line break, `pageData.chars.slice()` selects wrong characters.
* **Obs 1.2.3 — Text Selection Visual Highlight Pipeline**: In `inkwell-app/src/js/render/overlays.js` (lines 235–268) and `compositor.js` (lines 246–248):
  `drawPersistentTextSelectionHighlights` draws blue bounding boxes (`rgba(56, 189, 248, 0.32)`) on `_dctx` per rect in `state.textSelection.rects`.
* **Obs 1.2.4 — Copying Mechanism**: In `inkwell-app/src/js/workspace/text-selection.js` (lines 332–340):
  `copySelectedPdfText()` writes `state.selectedTextString` to `navigator.clipboard.writeText`. Wired in `commands.js` under `edit.copy` (`Ctrl+C`) and popover `#btnTextCopy`.

---

### 1.3 Full Toolsuite Mechanics & History

* **Obs 1.3.1 — Pen & Highlighter Pipeline**:
  - `js/tools/pen.js`: Fountain pen applies One-Euro + Streamline smoothing; highlighter applies chisel Path2D contour (`getChiselPath2D`) with `multiply` blending.
  - Commits to document state via `documentOps.addStroke(stroke, { recordHistory: true })` and asynchronously journals to WAL via `ipc.commitStroke`.
* **Obs 1.3.2 — Eraser Tool**:
  - `js/tools/eraser.js`: Proximity hit-testing (`eraseStrokesAt`) checks AABB bbox first, then segment distance `distToSegment`.
  - Deletes matching strokes via `documentOps.deleteStrokes(strokeIds, { recordHistory: true })` and journals deletion via `ipc.deleteStroke`.
* **Obs 1.3.3 — Lasso Tool & 8-Handle Matrix Transform**:
  - `js/tools/lasso.js`: Freeform polygon selection (`pointInPolygon`) and 8-handle transformation (`overlays.getSelectionHandleAt`, `applyInteractiveTransform`).
  - Commits transform to history via `documentOps.commitTransform`, supporting undo/redo.
* **Obs 1.3.4 — Shapes Tool**:
  - `js/tools/shapes.js`: Geometric generator for `rect` (40 samples), `ellipse` (64 samples), and `line` (20 samples). Commits vector strokes to document model and WAL.
* **Obs 1.3.5 — Text / Sticky Notes**:
  - `js/tools/text.js`: In-place editor `#inlineTextEditor` with `#inlineTextarea`. Enter commits, Escape cancels, Shift+Enter multi-lines. Persists via `documentOps.upsertTextObject` and `journal_text_mutation`.
* **Obs 1.3.6 — Laser Pointer**:
  - `js/tools/laser.js`: Decaying particle trail (1000ms max age) rendered on wet canvas with `shadowBlur`. Cleared on pointerup/cancel.

---

### 1.4 UI Wiring & Context Integrations

* **Obs 1.4.1 — Context Menu Listener Absent**: `js/ui/context-menu.js` provides `showContextMenu(screenX, screenY)`, but no `contextmenu` listener is attached to `#stage` or `window`.
* **Obs 1.4.2 — Radial Menu Class Mismatch**: In `js/ui/radial-menu.js` lines 33 & 49:
  `menu.querySelectorAll('.radial-slot')` queries `.radial-slot`, but `index.html` lines 804–834 defines buttons with class `radial-item`.
* **Obs 1.4.3 — Command Palette Keyboard Navigation**: `js/ui/command-palette.js` has no `keydown` listener on `#cmdPaletteInput` for ArrowUp, ArrowDown, Enter, or Escape.

---

## 2. Logic Chain

### 2.1 Spacebar Quick-Toggle & Pan Mechanics Logic Chain
1. **Fact (Obs 1.1.1)**: `handleSpringKeyDown` immediately sets `state.prevTool = state.activeTool` and `setTool('pan')`.
2. **Fact (Obs 1.1.1)**: `handleSpringKeyUp` sets `setTool(state.prevTool)`.
3. **Inference**: If a user taps Spacebar (< 250ms), it immediately switches to `pan` on keydown and reverts to the exact same tool on keyup. The previously used tool (e.g. switching between Pen and Eraser or Pen and Highlighter) is never activated.
4. **Fact (Obs 1.1.2, 1.1.3)**: When `state.activeTool === 'pan'`, left-click dragging matches no branch in `attachPointerHandlers`, and `ViewportManager` only responds to `e.button === 1` (middle button).
5. **Inference**: Holding Spacebar switches to Pan mode, but clicking and dragging the mouse on the canvas fails to move the canvas.
6. **Fact (Obs 1.1.4, 1.1.5)**: Spacebar keydown is not prevented from default browser actions, and window blur events are unhandled.
7. **Conclusion**: Spacebar must distinguish between a quick tap (toggle between `state.activeTool` and `state.lastActiveTool`) versus a hold (temporary pan mode reverting to tool active before spacebar press). Left-click dragging on `#wet` when `state.activeTool === 'pan'` must invoke `viewport.setPan()`. Space keydown must call `e.preventDefault()`, and `window.onblur` must cancel temporary pan.

---

### 2.2 Text Selection & PDF Layer Logic Chain
1. **Fact (Obs 1.2.1)**: `ensurePageTextData` is asynchronous. When a user clicks and begins dragging to select text, `pointermove` fires while `state.isSelectingText` is false.
2. **Inference**: Fast click-and-drag interactions are dropped or trigger state desynchronization where `isSelectingText` remains true after pointerup.
3. **Fact (Obs 1.2.2)**: In `text.rs`, newline characters are skipped when generating `all_chars`. In `text-selection.js`, `computeTextSelectionRanges` slices `pageData.chars` using `startCharIdx` and `endCharIdx` as array indices.
4. **Inference**: On multi-line documents, character indices diverge from array indices. Slicing by character ID causes highlights and copied text to be shifted.
5. **Fact (Obs 1.4.1)**: Context menu right-click copy is defined in `context-menu.js` but has no event trigger.
6. **Conclusion**: Text selection must pre-check cached text data synchronously on pointerdown; if loading, record `state.textSelectPending` for pointermove to pick up once resolved. In `text-selection.js`, find character array indices using `findIndex(c => c.char_index >= minIdx)` instead of raw array indexing. Attach `contextmenu` listener to canvas to trigger `showContextMenu`.

---

### 2.3 Toolsuite Reliability & History State Sync Logic Chain
1. **Fact (Obs 1.3.1–1.3.6)**: The 8 primary tools (Pen, Highlighter, Eraser, Lasso, Shapes, Text, Laser, Pan) have complete domain logic, visual rendering, and WAL integration.
2. **Fact (Obs 1.4.2, 1.4.3)**: Minor wiring bugs exist in secondary UI surfaces: radial menu queries `.radial-slot` instead of `.radial-item`, and command palette input lacks keyboard arrow/enter event handling.
3. **Conclusion**: Core tool logic is sound; repairs are localized to interaction state machines, event wiring, and index alignment.

---

## 3. Caveats

1. **Native Stylus Hardware Stream (`evdev`)**: Stylus stream on Linux uses `/dev/input/event*` channels via Tauri background threads. In non-root or standard desktop environments without raw evdev access, input gracefully falls back to browser `PointerEvent` pressure (`e.pressure`).
2. **PDF Annotation Vector vs Standard Annotation Layer**: InkWell embeds vector ribbon outlines directly into PDF content streams via `inkwell-pdf` rather than standard raster annotation popups, satisfying AGENTS.md Rule 1.
3. **Headless Testing Constraints**: Headless Chromium in Playwright tests requires mocking `window.__TAURI__` invoke commands (`render_tile`, `get_page_text_data`, `commit_stroke`).

---

## 4. Conclusion & Recommended Step-by-Step Fix Strategies

### Strategy 1: Spacebar Quick-Toggle & Pan Repair
1. **In `js/core/state.js`**:
   - Maintain `state.lastActiveTool` (initialized to `'eraser'`).
   - Track `state.isSpacePressed`, `state.spaceDownTime`, `state.spaceToolBefore`, and `state.spaceDidPan`.
2. **In `js/tools/tool-manager.js`**:
   - Update `setTool(newTool, { isUserSwitch = true } = {})`: When switched explicitly by user, update `state.lastActiveTool = state.activeTool` before setting `state.activeTool = newTool`.
   - Update `handleSpaceKeyDown(e)`:
     - If `state.isSpacePressed` or typing in input/textarea, return.
     - `e.preventDefault()`.
     - `state.isSpacePressed = true; state.spaceDownTime = performance.now(); state.spaceToolBefore = state.activeTool; state.spaceDidPan = false;`
     - Switch tool to `'pan'` without modifying `lastActiveTool`.
   - Update `handleSpaceKeyUp(e)`:
     - If `!state.isSpacePressed`, return.
     - `e.preventDefault()`.
     - `const duration = performance.now() - state.spaceDownTime;`
     - If `duration < 250 && !state.spaceDidPan`:
       - Tapped Spacebar! Toggle between `state.spaceToolBefore` and `state.lastActiveTool || 'pen'`.
     - Else:
       - Held Spacebar! Revert back to `state.spaceToolBefore || 'pen'`.
     - Reset `state.isSpacePressed = false; state.spaceDownTime = null; state.spaceToolBefore = null; state.spaceDidPan = false;`
3. **In `js/main.js`**:
   - Add Left-Click Panning Handler in `attachPointerHandlers`:
     - When `tool === 'pan'`, on `pointerdown`: record `state.panStartScreen = [e.clientX, e.clientY]`, `state.panStartPan = [viewport.panX, viewport.panY]`, `state.isPanningCanvas = true`.
     - On `pointermove`: if `state.isPanningCanvas`, calculate `dx = e.clientX - state.panStartScreen[0]`, `dy = e.clientY - state.panStartScreen[1]`, call `viewport.setPan(state.panStartPan[0] + dx, state.panStartPan[1] + dy, pane)`. Mark `state.spaceDidPan = true`.
     - On `pointerup` / `pointercancel`: reset `state.isPanningCanvas = false`.
   - Add `window.addEventListener('blur', ...)`: Cancel any active spring/space hold state.

---

### Strategy 2: Text Selection & PDF Text Layer Fixes
1. **In `js/main.js` (`pointerdown` for `textSelect`)**:
   - Check if `state.pageTextData[pageCoord.sheet]` is immediately available.
   - If available, execute selection hit-testing synchronously.
   - If loading, store `state.textSelectPending = { sheet: pageCoord.sheet, px: pageCoord.px, py: pageCoord.py, isDown: true }`. In `pointermove`, update pending position. When promise resolves, if `isDown`, compute selection range immediately.
2. **In `js/workspace/text-selection.js` (`computeTextSelectionRanges`)**:
   - Replace raw array slicing `pageData.chars.slice(minIdx, maxIdx + 1)` with:
     ```js
     const selectedChars = pageData.chars.filter(c => c.char_index >= minIdx && c.char_index <= maxIdx);
     ```
   - This ensures accurate character selection regardless of newline omission in the underlying data structure.
3. **In `js/main.js` (`attachPointerHandlers`)**:
   - Add `contextmenu` event listener on `wetCanvas` / `#stage`:
     ```js
     wetCanvas.addEventListener('contextmenu', e => {
       e.preventDefault();
       contextMenu.showContextMenu(e.clientX, e.clientY);
     });
     ```

---

### Strategy 3: UI Controls & Palette Navigation Polish
1. **In `js/ui/radial-menu.js`**:
   - Update selector from `menu.querySelectorAll('.radial-slot')` to `menu.querySelectorAll('.radial-item')`.
   - Handle both `data-tool` and `data-action` (`undo`, `palette`).
2. **In `js/ui/command-palette.js`**:
   - Add `keydown` listener on `cmdPaletteInput` for ArrowUp (decrement `_selectedIndex`), ArrowDown (increment `_selectedIndex`), Enter (execute selected command), and Escape (close palette).

---

## 5. Verification Method

To independently verify all findings and test subsequent implementations:

1. **Automated Smoke Test Verification**:
   ```bash
   cd /mnt/Work/Own\ Programs/InkWell/inkwell-app
   python3 test_app_smoke.py
   ```
   *Expected*: All 20/20 checks pass cleanly with 0 errors and 0 internal warnings.

2. **Expanded Playwright Test Cases for R2**:
   Add test suites to `test_app_smoke.py`:
   - **T8 Spacebar Quick-Toggle & Hold-Pan**:
     1. Select Pen tool, then Highlighter tool.
     2. Press & release Spacebar (<100ms) -> Verify tool switches back to Pen.
     3. Press & release Spacebar again -> Verify tool switches to Highlighter.
     4. Press & hold Spacebar -> Verify tool switches to Pan; drag mouse 50px -> Verify `viewport.panX/panY` updates; release Spacebar -> Verify tool restores to Highlighter.
   - **T9 Text Selection & Clipboard**:
     1. Switch to `textSelect` tool.
     2. Dispatch mousedown + mousemove over text coords.
     3. Verify `state.textSelection` and `state.selectedTextString` are populated and `textSelectionPopover` is visible.
     4. Trigger `edit.copy` -> Verify `copySelectedPdfText()` executes.
   - **T10 Context Menu & Radial Menu**:
     1. Dispatch right click on canvas -> Verify `#canvasContextMenu` is not hidden.
     2. Click radial menu item -> Verify tool switches correctly.

3. **Rust Workspace Baseline**:
   ```bash
   cd /mnt/Work/Own\ Programs/InkWell/inkwell
   cargo test --workspace -- --test-threads=1
   cargo clippy --all-targets
   ```
   *Expected*: All 72 tests pass, 0 clippy warnings.

4. **Invalidation Conditions**:
   - Spacebar tap leaves tool stuck in pan mode.
   - Dragging across multiple lines in PDF highlights text with offset characters.
   - Left-click drag with Pan tool active fails to update viewport coordinates.

---
*End of Report.*
