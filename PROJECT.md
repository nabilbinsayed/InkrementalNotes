# Project: InkWell Full Optimization, Tool Repair & Cross-Platform Stability

## Architecture
InkWell is a high-performance, low-latency, PDF-native annotator and digital ink workspace.
The architecture is partitioned into:
1. **Core Rust Workspace (`inkwell/crates/`)**:
   - `inkwell-core`: Document model, ink math (One-Euro filter, Streamline, RDP simplification, ribbon outline generation), Write-Ahead Log engine (`wal.rs`), spatial AABB bounding box indexing (`spatial.rs`), tile cache (`tiles.rs`), and binary `IWSC` codec.
   - `inkwell-pdf`: Low-level PDF parser (`pdf.rs`), object structure (`pdfobj.rs`), PDFium dynamic normalisation engine (`pdfium.rs`, `text.rs`).
   - `inkwell-wal`: Durable transaction journal with FNV-1a checksums and atomic sibling replacement.
2. **Desktop Application Host (`inkwell-app/`)**:
   - `src-tauri/`: Tauri v2 IPC commands (`commands.rs`), application state (`state.rs`), Linux evdev stylus thread (`stylus_linux.rs`), and entry point (`main.rs`).
   - `src/`: Web frontend UI:
     - `index.html`, `styles.css`
     - `js/core/`: `state.js`, `document.js`, `ipc.js`, `commands.js`
     - `js/tools/`: `tool-manager.js`, `pen.js`, `eraser.js`, `lasso.js`, `shapes.js`, `text.js`, `laser.js`
     - `js/render/`: `compositor.js`, `tiles.js`, `overlays.js`, `templates.js`, `ink.js`
     - `js/ui/`: `radial-menu.js`, `command-palette.js`, `context-menu.js`, `toast.js`, `dialogs.js`
     - `js/workspace/`: `viewport.js`, `text-selection.js`, `search.js`, `outline.js`, `thumbnails.js`, `tabs.js`
     - `js/main.js`: Event routing, pointer event handlers, keyboard shortcuts, and startup coordination.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F01 | Cross-Platform Dynamic PDFium Loading | Multi-path resolution for `pdfium.dll`, `libpdfium.so`, `libpdfium.dylib` with `build.rs` auto-bundling | M1 | Survey |
| F02 | Spacebar Quick-Toggle State Machine | Tapping (<250ms) toggles between current tool and last active tool | M1 | Survey |
| F03 | Spacebar Hold-to-Pan Interaction | Holding (>=250ms) enters temporary pan mode, left-click drag moves canvas, releasing reverts to previous tool | M1 | Survey |
| F04 | Left-Click Canvas Panning | Dragging canvas with left mouse button when in Pan mode updates viewport coordinates | M1 | Survey |
| F05 | PDF Text Selection Async Resolution | Synchronous cache check with deferred pending resolution to prevent dropped drag selections | M1 | Survey |
| F06 | Multi-Line Character Index Alignment | Character index filtering (`filter(c => c.char_index >= min && c.char_index <= max)`) to prevent newline offset bug | M1 | Survey |
| F07 | Text Selection Highlight & Copy | Persistent visual highlight overlay and clipboard copy (`Ctrl+C` and popover button) | M1 | Survey |
| F08 | Canvas Context Menu Trigger | Right-click event listener on canvas triggering context menu with text copy, cut, paste, undo/redo | M1 | Survey |
| F09 | Radial Tool Menu Query Selector Fix | Update query selector from `.radial-slot` to `.radial-item` so quick radial switching works | M1 | Survey |
| F10 | Command Palette Keyboard Navigation | ArrowUp, ArrowDown, Enter, and Escape keyboard navigation in command palette | M1 | Survey |
| F11 | Tool History Tracking Sync | `setTool` preserves `state.lastActiveTool` across all user tool selections | M1 | Survey |
| F12 | Full Toolsuite Reliability | Clean state transitions and undo/redo history for Pen, Highlighter, Eraser, Lasso, Shapes, Text, Laser | M1 | Survey |
| F13 | Touch Target Accessibility Expansion | Increase interactive hit areas to >= 44x44px for secondary buttons (`.header-icon-btn`, `.nav-cluster-btn`, `.zoom-dock-btn`, `.tab-add-btn`, `.tab-close`) | M2 | Survey |
| F14 | Glassmorphic Toast & Focus Rings | Polished glassmorphic notifications, accessible `:focus-visible` rings, and zero UI regressions | M2 | Survey |
| F15 | 60+ FPS Rendering & Inking Pipeline | Triple-canvas pipeline (`tiles`, `dry`, `wet`), Path2D caching, AABB viewport culling, One-Euro filtering | M2 | Survey |
| F16 | Smoke Test Suite Expansion | Comprehensive test cases in `test_app_smoke.py` covering Spacebar toggle/pan, text selection, and context menu | M3 | Survey |
| F17 | Rust Workspace Test Suite Verification | Full verification of 72 unit/integration tests with zero failures/panics | M3 | Survey |
| F18 | Clippy & Static Analysis Cleanliness | Zero compiler warnings and clean static analysis across all crates | M3 | Survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Tool Repair & Interaction Polish | Spacebar toggle/pan, PDF text selection & copy, context menu, radial menu, command palette, tool history tracking (F01-F12) | none | DONE |
| M2 | UI/UX & Touch Ergonomics Optimization | Touch target expansion (>=44x44px), CSS focus/toast polish, rendering latency hygiene (F13-F15) | M1 | DONE |
| M3 | Comprehensive Verification & Smoke Suite | Expand `test_app_smoke.py` with spacebar, text selection, context menu checks; verify 100% test pass on Rust & desktop smoke tests (F16-F18) | M1, M2 | DONE |

## Interface Contracts
### `toolManager` ↔ `state`
- `state.lastActiveTool`: string (`'pen'`, `'highlighter'`, `'eraser'`, `'lasso'`, `'rect'`, `'text'`, `'laser'`)
- `state.isSpacePressed`: boolean
- `state.spaceDownTime`: number (timestamp in ms)
- `state.spaceToolBefore`: string | null
- `state.spaceDidPan`: boolean
- `toolManager.setTool(toolName, { isUserSwitch = true })`: updates `state.lastActiveTool` when `isUserSwitch` is true and `toolName !== 'pan'`.
- `toolManager.handleSpaceKeyDown(e)`: enters pan mode on Space keydown, prevents default browser scrolling.
- `toolManager.handleSpaceKeyUp(e)`: toggles last tool if duration < 250ms and no pan occurred; reverts to previous tool if held >= 250ms or panned.

### `textSelection` ↔ `compositor` / `overlays`
- `textSelection.computeTextSelectionRanges(sheet, startCharIdx, endCharIdx)`: returns `{ sheet, startCharIdx, endCharIdx, rects: [...] }`.
- Filter characters by `c.char_index >= minIdx && c.char_index <= maxIdx`.
- `overlays.drawPersistentTextSelectionHighlights(_dctx, viewport)`: iterates `state.textSelection.rects` and fills selection rects.

### `viewport` ↔ `main.js` (Canvas Panning)
- When `state.activeTool === 'pan'`, on pointerdown: record start screen coordinates and current viewport pan.
- On pointermove: calculate delta, invoke `viewport.setPan(newPanX, newPanY, pane)`.
- Mark `state.spaceDidPan = true` if panning occurred.

## Code Layout
- `inkwell/crates/inkwell-core/`: Core mathematical and document algorithms
- `inkwell/crates/inkwell-pdf/`: PDFium binding and text layer extraction
- `inkwell/crates/inkwell-wal/`: Write-ahead log durability
- `inkwell-app/src-tauri/`: Tauri v2 host backend
- `inkwell-app/src/`: Frontend UI & interaction engine
  - `src/index.html`: Main markup, toolbars, radial menus, popovers, modals
  - `src/styles.css`: Glassmorphic styling, touch targets, focus states
  - `src/js/core/state.js`: Global reactive application state
  - `src/js/tools/tool-manager.js`: Tool switching, spring key handling
  - `src/js/workspace/text-selection.js`: PDF text selection, hit-testing, clipboard copy
  - `src/js/workspace/viewport.js`: Canvas zoom, pan, coordinate transforms
  - `src/js/ui/radial-menu.js`: Circular quick-access tool palette
  - `src/js/ui/command-palette.js`: Command palette modal with keyboard navigation
  - `src/js/ui/context-menu.js`: Canvas context menu
  - `src/js/main.js`: Main event orchestration and pointer handlers
- `inkwell-app/test_app_smoke.py`: Playwright smoke test suite
