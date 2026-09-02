# Milestone 1 Adversarial Challenge Report — Empirical Verification & Stress Test

**Challenger**: challenger_m1_1 (critic / specialist)  
**Milestone**: Milestone 1: Tool Repair & Interaction Polish (F01–F12)  
**Target Files Reviewed**:
- `inkwell-app/src/js/tools/tool-manager.js`
- `inkwell-app/src/js/workspace/text-selection.js`
- `inkwell-app/src/js/ui/context-menu.js`
- `inkwell-app/src/js/ui/radial-menu.js`
- `inkwell-app/src/js/ui/command-palette.js`
- `inkwell-app/src/js/main.js`
**Verdict**: **APPROVE**  
**Date**: 2026-09-02  

---

## 1. Observation

Direct automated testing and code inspection were conducted across the desktop frontend and Rust core workspaces:

### Automated Test Executions
1. **Desktop App Smoke Test (`test_app_smoke.py`)**:
   - Command: `uv run --with playwright python3 test_app_smoke.py`
   - Output: `20/20 checks passed` (Exit code 0)
   - Verified clean boot, ES module resolution, 9-dock tool toggles, canvas compositing, zoom controls, and zero console errors.

2. **Milestone 1 Interactive Verification (`test_m1_interactive.py`)**:
   - Command: `uv run --with playwright python3 test_m1_interactive.py`
   - Output: `19/19 interactive checks passed` (Exit code 0)
   - Verified spacebar quick-toggle (<250ms), hold-to-pan (>=250ms), left-click pan canvas dragging, multi-line character selection, canvas right-click context menu, radial menu, and command palette navigation.

3. **Adversarial Stress Test Suite (`test_m1_adversarial.py`)**:
   - Command: `uv run --with playwright python3 test_m1_adversarial.py`
   - Output: `37/37 checks passed (0 failures) in 5.92s` (Exit code 0)
   - Stress-tested 8 attack vectors:
     - **Suite 1: Rapid-Fire Spacebar Tapping & Spring State Machine**:
       - 20 ultra-rapid spacebar tap cycles (10ms down, 10ms up) maintained clean state and never remained stuck in `'pan'` mode (`isSpacePressed = false`, `activeTool = 'pen'`).
       - 10 OS key-repeat events while holding Spacebar maintained `spaceToolBefore`.
       - Spacebar presses inside focused text inputs (`#cmdPaletteInput`) were prevented from triggering tool switching.
       - Window `blur` events immediately cancelled active spring keys.
     - **Suite 2: Spacebar Hold Across Viewport Edges & Canvas Dragging**:
       - Mouse drags 800px past viewport boundaries during spacebar hold updated `panX` continuously without NaN or exceptions (`init=205, after=1005`).
       - Releasing Spacebar mid-drag cleanly restored the previous tool without crash.
       - Dispatching `pointercancel` cleanly reset `_panState.isDown = false`.
     - **Suite 3: PDF Text Selection Engine Stress & Edge Cases**:
       - Empty page (0 chars) returned `null` for `findCharAndOffsetAtPageCoord`, `computeTextSelectionRanges`, `expandSelectionToWord`, and `expandSelectionToLine` without throwing.
       - Single-character page hit-tested and extracted `'Z'` accurately.
       - Reverse drag selection (bottom-right to top-left) across non-contiguous newline-omitted char indices produced correct range `[0..26]` spanning multiple lines.
       - Out-of-bounds indices (`-100` to `9999`) clamped safely and returned all available page text (`'The quick foxInkWellThird line'`).
       - Far out-of-bounds hit coordinates (`-5000`, `5000`) correctly clamped to line boundary characters (`isBefore = true` and `isAfter = true`).
       - Clipboard copy via `copySelectedPdfText()` successfully wrote `'The quick'` to system clipboard.
     - **Suite 4: Context Menu Boundaries & Dismissals**:
       - Context menu triggered at viewport extreme `(1390, 890)` was clamped within bounds (`left=1210, top=690`).
       - Canvas click dismissed context menu.
       - Cut, Copy, Paste, Duplicate, Delete executed on empty selections without unhandled exceptions.
     - **Suite 5: Radial Menu & Command Palette Stress**:
       - Radial menu survived 30 rapid open/close cycles without state corruption.
       - Command palette ArrowUp wrapped to bottom (`idx=27`), ArrowDown wrapped to top (`idx=0`).
       - Search input fuzzing with HTML script tags and symbols caused zero DOM breakage.
     - **Suite 6: Multi-Key Spring Interleaving**:
       - Interleaving `'E'` (spring eraser) and Spacebar (spring pan) transitions cleanly reverted to `'highlighter'` upon release.
     - **Suite 7: Text Layer IPC Failure Graceful Degradation**:
       - IPC rejection during text extraction returned `null` gracefully with controlled warning and zero unhandled promise rejections.
     - **Suite 8: 9-Tool Exhaustive Transition Matrix**:
       - All 72 pairwise transitions across the 9 primary tools preserved `lastActiveTool` state accurately.

4. **Rust Workspace Core Tests**:
   - Command: `cargo test --workspace -- --test-threads=1`
   - Output: `72 passed; 0 failed; 0 ignored` (Exit code 0)

---

## 2. Logic Chain

1. **State Machine Invariant Preservation**:
   - In `tool-manager.js`, `setTool` updates `state.lastActiveTool = state.activeTool` strictly when `isUserSwitch` is true and `tool !== 'pan'`.
   - `handleSpaceKeyDown` saves `spaceToolBefore = state.activeTool` and only modifies `state.activeTool` with `isUserSwitch: false`.
   - Under rapid-fire tapping (20 cycles of 10ms), key repeat storms, and mid-drag key releases, `state.isSpacePressed` and `state.activeTool` returned predictably to their pre-pan states without state leakage.

2. **Text Selection Spatial Alignment**:
   - In `text-selection.js`, `computeTextSelectionRanges` utilizes `pageData.chars.filter(c => c.char_index >= minIdx && c.char_index <= maxIdx)`.
   - This prevents index drift across omitted newline characters in Rust's `PageTextData`.
   - Reverse drag selections (`startCharIdx > endCharIdx`) are normalized via `Math.min`/`Math.max`, yielding consistent character and bounding box extraction.

3. **UI Robustness Under Boundary Conditions**:
   - Clamping logic in `context-menu.js` (`Math.min(window.innerWidth - w - 10, screenX)`) prevents off-screen placement.
   - Command palette wrap-around modular arithmetic (`(_selectedIndex + 1) % len` and `(_selectedIndex - 1 + len) % len`) guarantees index safety.

---

## 3. Caveats

1. **Native Evdev Stylus Device Stream**: Native Linux tablet device paths (`/dev/input/event*`) were tested via standard PointerEvent and synthetic browser pressure events rather than physical tablet digitizer hardware.
2. **Multi-Page Split View Text Dragging**: Dragging a text selection across the split-pane boundary between left and right sheets is currently isolated to the sheet in which the pointer originated (standard PDF multi-view behavior).

---

## 4. Conclusion

**Verdict**: **APPROVE**

Milestone 1 satisfies all functional, architectural, and adversarial criteria:
- Spacebar quick-toggle (<250ms) and hold-to-pan (>=250ms) are resilient against rapid tapping, repeat storms, blur events, and input typing guards.
- PDF text selection correctly handles empty pages, single characters, reverse dragging, multi-line newline offsets, out-of-bounds coordinates, and clipboard copy.
- Canvas context menu and radial menus correctly clamp to screen edges and dismiss reliably.
- Command palette supports full keyboard navigation and survives malicious search input fuzzing.
- All 148 combined automated tests (20 smoke + 19 interactive + 37 adversarial + 72 Rust) pass with 0 errors and 0 warnings.

---

## 5. Verification Method

To independently reproduce all verification and adversarial stress tests:

```bash
# 1. Desktop App Smoke Suite (20 checks)
cd /mnt/Work/Own\ Programs/InkWell/inkwell-app
uv run --with playwright python3 test_app_smoke.py

# 2. Milestone 1 Interactive Verification (19 checks)
uv run --with playwright python3 test_m1_interactive.py

# 3. Milestone 1 Adversarial Stress Suite (37 checks)
uv run --with playwright python3 test_m1_adversarial.py

# 4. Rust Core Workspace Test Suite (72 tests)
cd /mnt/Work/Own\ Programs/InkWell/inkwell
cargo test --workspace -- --test-threads=1
```
