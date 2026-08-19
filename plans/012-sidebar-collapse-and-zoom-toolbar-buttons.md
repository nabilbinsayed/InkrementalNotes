# Plan 012: Sidebar Collapse CSS Fix & Dedicated Zoom Toolbar Buttons

> **Executor instructions**: Follow this plan step by step. Run every verification step before proceeding to the next. Do not modify files outside the **In scope** list. When finished, update the status for Plan 012 in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5af0855..HEAD -- inkwell-app/src/index.html inkwell-app/src/styles.css inkwell-app/src/js/app.js`

## Status

- **Priority**: P1 (UI Usability & Quick Fixes)
- **Effort**: S (Small & achievable in ~5 minutes)
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / feature
- **Target Model**: DeepSeek v4 Flash / Cline

---

## Why This Plan Exists

This plan solves two high-visibility frontend UX bugs with simple, zero-risk edits:
1. **Sidebar Collapse Not Hiding**: Clicking the sidebar panel toggle button (`📑` / `Ctrl+B`) or the collapse arrow (`▶`) toggles class `.collapsed` on `#sidebar`, but the panel does not hide because `styles.css` is missing the `#sidebar.collapsed` rule.
2. **Missing Toolbar Zoom Buttons**: Users currently have to use `Ctrl + MouseWheel` to zoom. Adding explicit `Zoom Out (-)`, `Zoom In (+)` and `Fit Page (⤢)` buttons directly on the floating toolbar provides immediate, easy zooming controls.

---

## In Scope Files

- `inkwell-app/src/styles.css`
- `inkwell-app/src/index.html`
- `inkwell-app/src/js/app.js`

## Out of Scope Files (Do NOT Touch)

- Any file under `inkwell/crates/` (Rust code)
- `inkwell-app/src/js/viewport.js`
- `inkwell-app/src-tauri/`

---

## Step-by-Step Implementation

### Step 1: Add Missing `#sidebar.collapsed` Rule to `styles.css`

Open `inkwell-app/src/styles.css`.

Find the `#sidebar` style block (around line 120):
```css
#sidebar {
  width: 280px;
  height: 100%;
  background: var(--bg-panel);
  backdrop-filter: blur(12px);
  border-left: 1px solid var(--border);
  z-index: 10;
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 16px;
}
```

Directly after the `#sidebar` block, add the following CSS rule:

```css
#sidebar.collapsed {
  display: none !important;
}
```

**Verification**:
Open the app in browser or Tauri host. Click `📑` (Toggle Sidebar) on the toolbar. The sidebar panel should collapse and hide completely, leaving the full canvas stage visible. Click `📑` again to expand it back.

---

### Step 2: Add Zoom Buttons to Toolbar in `index.html`

Open `inkwell-app/src/index.html`.

Find the toolbar element `<div id="toolbar">` (around line 14).

Add the zoom buttons and zoom level display directly after the `btnSplit` button:

```html
      <div class="divider"></div>
      <button id="btnZoomOut" class="tool-btn" title="Zoom Out (-)">🔍-</button>
      <span id="zoomLevelDisplay" style="font-size:12px; color:var(--text-muted); min-width:36px; text-align:center; user-select:none;">100%</span>
      <button id="btnZoomIn" class="tool-btn" title="Zoom In (+)">🔍+</button>
      <button id="btnZoomFit" class="tool-btn" title="Fit Page (⤢)">⤢</button>
```

**Full toolbar structure snippet**:
```html
    <div id="toolbar">
      <button id="btnPen" class="tool-btn active" title="Pen (P)">🖊️</button>
      <button id="btnHighlighter" class="tool-btn" title="Highlighter (H)">🖍️</button>
      <button id="btnEraser" class="tool-btn" title="Eraser — hold E for spring-load (E)">🧹</button>
      <div class="divider"></div>
      <button id="btnLasso" class="tool-btn" title="Lasso erase (V)">⬚</button>
      <button id="btnRuler" class="tool-btn" title="Line — Shift to snap 45° (R)">📐</button>
      <button id="btnRect" class="tool-btn" title="Rectangle — Shift for square (Q)">▭</button>
      <button id="btnEllipse" class="tool-btn" title="Ellipse — Shift for circle (O)">◯</button>
      <div class="divider"></div>
      <button id="btnLaser" class="tool-btn" title="Laser pointer — hold L (L)">🔴</button>
      <div class="divider"></div>
      <button id="btnProp" class="tool-btn" title="Tool Properties">⚙️</button>
      <input type="color" id="colorPicker" value="#141724" title="Ink colour" style="border:none; background:none; cursor:pointer; width:24px; height:24px;">
      <div class="divider"></div>
      <button id="btnSplit" class="tool-btn" title="Toggle Split View">◫</button>
      <button id="btnZoomOut" class="tool-btn" title="Zoom Out (-)">🔍-</button>
      <span id="zoomLevelDisplay" style="font-size:12px; color:var(--text-muted); min-width:36px; text-align:center; user-select:none;">100%</span>
      <button id="btnZoomIn" class="tool-btn" title="Zoom In (+)">🔍+</button>
      <button id="btnZoomFit" class="tool-btn" title="Fit Page (⤢)">⤢</button>
      <div class="divider"></div>
      <button id="btnToggleSidebar" class="tool-btn active" title="Toggle Sidebar Panel (Ctrl+B)">📑</button>
      <button id="btnCmdPalette" class="tool-btn" title="Command Palette (Ctrl+Shift+P)">🔍</button>
      <div class="divider"></div>
      <button id="btnUndo" class="tool-btn" title="Undo (Ctrl+Z)">↩️</button>
      <button id="btnRedo" class="tool-btn" title="Redo (Ctrl+Y)">↪️</button>
    </div>
```

---

### Step 3: Bind Zoom Buttons in `app.js`

Open `inkwell-app/src/js/app.js`.

Find the `bindUI()` function (around line 500).

Add event listeners for `btnZoomIn`, `btnZoomOut`, and `btnZoomFit`:

```javascript
  $('btnZoomIn') && $('btnZoomIn').addEventListener('click', () => {
    const pane = viewport.activePane || 'left';
    const curZoom = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
    const center = [tilesCanvas.width / (2 * state.dpr), tilesCanvas.height / (2 * state.dpr)];
    viewport.setZoom(curZoom * 1.25, center, pane);
  });

  $('btnZoomOut') && $('btnZoomOut').addEventListener('click', () => {
    const pane = viewport.activePane || 'left';
    const curZoom = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
    const center = [tilesCanvas.width / (2 * state.dpr), tilesCanvas.height / (2 * state.dpr)];
    viewport.setZoom(curZoom / 1.25, center, pane);
  });

  $('btnZoomFit') && $('btnZoomFit').addEventListener('click', () => {
    centerPageInPanes();
    scheduleRedrawTiles();
    redrawAll();
  });
```

Also, update `drawZoomIndicator()` in `app.js` to update the `#zoomLevelDisplay` span element text if present:

Inside `drawZoomIndicator()`:
```javascript
  const activeZoom = viewport.splitMode && viewport.activePane === 'right' ? viewport.rightZoom : viewport.zoom;
  if ($('zoomLevelDisplay')) {
    $('zoomLevelDisplay').textContent = Math.round(activeZoom * 100) + '%';
  }
```

---

## Machine-Checkable Done Criteria

- [ ] `#sidebar.collapsed` rule exists in `styles.css`.
- [ ] `#btnZoomIn`, `#btnZoomOut`, `#btnZoomFit`, `#zoomLevelDisplay` exist in `index.html`.
- [ ] Event listeners for `btnZoomIn`, `btnZoomOut`, `btnZoomFit` are registered in `bindUI()` in `app.js`.
- [ ] Clicking `🔍+` increases zoom level; clicking `🔍-` decreases zoom level; clicking `⤢` fits page.
- [ ] Clicking `📑` hides/shows the sidebar panel cleanly.
- [ ] Status row for Plan 012 in `plans/README.md` updated to `DONE`.

---

## STOP Conditions

Stop and report back if:
- Clicking zoom buttons throws JavaScript errors in console (F12).
- The toolbar wraps onto multiple lines awkwardly — adjust font-size or button padding if needed.
