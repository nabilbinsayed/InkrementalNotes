# Plan 009: Polished Split View with Independent Zoom, Clear Page Selectors, and Divider

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 366b074..HEAD -- inkwell-app/src/js/app.js inkwell-app/src/js/viewport.js inkwell-app/src/index.html inkwell-app/src/styles.css`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/008 (positioning fix must land first so tiles render correctly)
- **Category**: bug / feature
- **Planned at**: commit `366b074`, 2026-08-08

## Why this matters

The user reported three related problems with split view:
1. **No clear page selection**: When split view opens, pages are chosen somewhat arbitrarily. Users want explicit L: and R: page selectors to choose which page goes where.
2. **Independent zoom is incomplete**: Although `viewport.js` has separate `rightZoom`/`rightPanX`/`rightPanY` state and wheel events target the correct pane, mouse/trackpad *pinch-zoom* doesn't work independently. Also, zoom indicators don't show the current zoom level per pane.
3. **No visual divider**: Nothing separates the two panes visually; the split is invisible.

## Current state

### `inkwell-app/src/js/viewport.js` (114 lines)

The `ViewportManager` class already supports:
- Separate `panX/panY/zoom` and `rightPanX/rightPanY/rightZoom` state
- `setZoom(z, centerPx, pane)` correctly applies to the targeted pane
- `attachListeners()` handles wheel events with `Ctrl+wheel` for zoom and plain wheel for pan, targeting the correct pane based on cursor X position

**What's missing**: No pinch-to-zoom (gesture events). No middle-mouse-button drag for panning.

### `inkwell-app/src/index.html` (lines 61-75)

Page navigation bar has Left/Right navigation:
```html
<div id="pageNav">
  <span id="leftNavLabel" class="nav-label hidden">L:</span>
  <button id="btnPrev" class="nav-btn" disabled>‹</button>
  <span id="pageNum">—</span>
  <button id="btnNext" class="nav-btn" disabled>›</button>

  <div id="splitPageNav" class="hidden" style="display:inline-flex; ...">
    <span class="nav-label">R:</span>
    <button id="btnRightPrev" class="nav-btn">‹</button>
    <span id="rightPageNum">—</span>
    <button id="btnRightNext" class="nav-btn">›</button>
  </div>
  <button id="btnAddPage" class="nav-btn" title="Insert Blank Page">+</button>
</div>
```

**What's wrong**: The `splitPageNav` div has `class="hidden"` **and** `style="display:inline-flex"`. The CSS `hidden` class likely sets `display:none`, but the inline style `display:inline-flex` may override it depending on specificity, causing inconsistent show/hide behavior.

### `inkwell-app/src/js/app.js`

The `updatePageUI()` function (around line 285) toggles the `hidden` class on `splitPageNav` and `leftNavLabel`. The `goToPage()` function (around line 260) handles page changes per pane.

The `centerPageInPanes()` function (around line 271) computes fit-to-page zoom for both panes independently. This is correct but only runs on page change — if the user manually zooms then navigates pages, the zoom is reset.

### `inkwell-app/src/styles.css` (449 lines)

The stylesheet defines the overall dark theme but has no split-view divider styles.

## Commands you will need

| Purpose   | Command                                         | Expected on success        |
|-----------|------------------------------------------------|----------------------------|
| Dev run   | Launch via `launch inkwell.bat`                | App opens, PDF renders     |

## Scope

**In scope** (the only files you should modify):
- `inkwell-app/src/index.html` — fix the inline style bug on `splitPageNav`, add zoom indicators
- `inkwell-app/src/js/app.js` — improve split view toggle, page selector UX, add divider drawing, add zoom level display
- `inkwell-app/src/js/viewport.js` — add middle-mouse panning, gesture pinch-to-zoom
- `inkwell-app/src/styles.css` — add split divider styles, zoom indicator styles

**Out of scope**:
- Any Rust backend code
- `inkwell-app/src/js/ink.js` — stroke rendering is unrelated

## Steps

### Step 1: Fix the `splitPageNav` inline style bug

In `inkwell-app/src/index.html`, the `splitPageNav` div has conflicting `class="hidden"` and `style="display:inline-flex"`. Remove the inline style — the display should be managed entirely by CSS class toggling.

**Replace** (line 67):
```html
<div id="splitPageNav" class="hidden" style="display:inline-flex; align-items:center; gap:6px; margin-left:8px; border-left:1px solid rgba(255,255,255,0.15); padding-left:8px;">
```
**With**:
```html
<div id="splitPageNav" class="split-nav hidden">
```

**Add** to `inkwell-app/src/styles.css`:
```css
#splitPageNav, .split-nav {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  border-left: 1px solid rgba(255,255,255,0.15);
  padding-left: 8px;
}
#splitPageNav.hidden { display: none; }
```

**Verify**: Open InkWell without split view — the R: nav should be hidden. Toggle split view — R: nav should appear.

### Step 2: Draw a visible split divider line

In `inkwell-app/src/js/app.js`, add a function to draw a vertical divider line between panes when split mode is active. Call it after `redrawTiles()`.

Add after the `redrawTiles()` function:

```javascript
function drawSplitDivider() {
  if (!viewport || !viewport.splitMode) return;
  const w = tilesCanvas.width / state.dpr;
  const h = tilesCanvas.height / state.dpr;
  const cx = w / 2;
  tctx.save();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.scale(state.dpr, state.dpr);
  // Dark translucent divider
  tctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  tctx.lineWidth = 1.5;
  tctx.beginPath();
  tctx.moveTo(cx, 0);
  tctx.lineTo(cx, h);
  tctx.stroke();
  tctx.restore();
}
```

Call `drawSplitDivider()` at the end of `redrawTiles()`, after the `Promise.all(...)`.

**Verify**: Toggle split view. A subtle vertical line should appear at the center dividing the two panes.

### Step 3: Add zoom level indicator per pane

Add a subtle zoom percentage display at the bottom of each pane.

In `inkwell-app/src/js/app.js`, add a function:

```javascript
function drawZoomIndicator() {
  if (!viewport) return;
  const panes = visiblePanes();
  tctx.save();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.scale(state.dpr, state.dpr);
  tctx.font = '11px system-ui, -apple-system, sans-serif';
  tctx.textBaseline = 'bottom';
  
  for (const pane of panes) {
    const bounds = paneBounds(pane);
    const z = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
    const pct = Math.round(z * 100) + '%';
    tctx.textAlign = 'right';
    tctx.fillStyle = 'rgba(255,255,255,0.35)';
    tctx.fillText(pct, bounds.x + bounds.width - 8, bounds.y + bounds.height - 6);
  }
  tctx.restore();
}
```

Call `drawZoomIndicator()` at the end of `redrawTiles()`, after `drawSplitDivider()`.

**Verify**: Zoom in/out on a pane. The percentage should update live at the bottom-right of each pane.

### Step 4: Add middle-mouse-button panning

In `inkwell-app/src/js/viewport.js`, add middle-mouse-button (button 1) panning support inside `attachListeners()`:

```javascript
// Middle-mouse panning
element.addEventListener('pointerdown', e => {
  if (e.button !== 1) return; // middle button only
  e.preventDefault();
  const stageRect = element.getBoundingClientRect();
  const relX = e.clientX - stageRect.left;
  this.isPanning = true;
  this.lastPanPt = [e.clientX, e.clientY];
  this.activePane = (this.splitMode && relX > stageRect.width / 2) ? 'right' : 'left';
  element.setPointerCapture(e.pointerId);
});

element.addEventListener('pointermove', e => {
  if (!this.isPanning) return;
  const dx = e.clientX - this.lastPanPt[0];
  const dy = e.clientY - this.lastPanPt[1];
  this.lastPanPt = [e.clientX, e.clientY];
  const pane = this.activePane;
  const curPanX = pane === 'right' ? this.rightPanX : this.panX;
  const curPanY = pane === 'right' ? this.rightPanY : this.panY;
  this.setPan(curPanX + dx, curPanY + dy, pane);
});

element.addEventListener('pointerup', e => {
  if (e.button !== 1) return;
  this.isPanning = false;
  try { element.releasePointerCapture(e.pointerId); } catch (_) {}
});
```

**Verify**: Open a PDF, hold middle mouse button and drag — the canvas should pan. In split view, each pane should pan independently.

### Step 5: Improve split view toggle behavior

In `inkwell-app/src/js/app.js`, update `toggleSplitView()` to:
1. When enabling split: set right pane to `leftSheet + 1` (next page) if available, otherwise same page
2. When disabling split: preserve the left pane's page, don't reset zoom

The current implementation already does #1 but should also properly update the page navigation display.

**Verify**: Toggle split view on/off. Left page should not change when disabling. Right pane starts at next page when enabling.

## Test plan

- **Manual test 1**: Open a 31-page PDF in InkWell. Toggle split view on. Verify:
  - Left pane shows page 1, right pane shows page 2
  - The L: and R: labels and page numbers appear in the bottom nav
  - A subtle vertical divider separates the panes
  - Zoom percentages appear at bottom-right of each pane
- **Manual test 2**: In split view, scroll/pinch-zoom the right pane. Verify left pane doesn't move.
- **Manual test 3**: Use R: navigation buttons to go to page 15 on the right while left stays on page 1.
- **Manual test 4**: Disable split view. Verify left pane page is preserved, right pane controls disappear.

## Done criteria

- [ ] Split view shows a visible divider between panes
- [ ] L: and R: page selectors work correctly and update independently
- [ ] Zoom level indicators show per-pane zoom percentage
- [ ] Middle-mouse-button panning works per-pane
- [ ] Zoom via Ctrl+scroll works independently per pane
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:
- The code at the locations in "Current state" doesn't match the excerpts (codebase drift).
- The `hidden` class CSS doesn't use `display:none` — check `styles.css` first.
- Adding event listeners to `element` in `attachListeners()` interferes with ink drawing on the `wet` canvas.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The divider line is drawn on the `tctx` (tiles canvas) so it sits behind ink strokes. If the user draws near the center, ink will correctly overlap the divider.
- Middle-mouse pan uses pointer capture, which may conflict with browser defaults on some systems. If users report issues, the fallback is the existing scroll-wheel panning.
- If a third pane is ever added, the `paneBounds()` function and divider drawing need generalization.
