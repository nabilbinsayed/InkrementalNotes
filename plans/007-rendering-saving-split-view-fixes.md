# Plan 007: Performance, Positioning, Independent Split Zoom, & PDF Y-Axis Save Coordinate Fix

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm expected results before moving to the next step. When done, update `plans/README.md`.

## Status

- **Priority**: P0 (Critical user experience and data correctness)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/006 (PDFium Singleton Cache)
- **Category**: bug / feature / perf
- **Planned at**: 2026-08-08

---

## Executive Summary & Root Cause Analysis

Based on empirical testing and codebase investigation, five key issues remain:

1. **PDF Annotation Y-Axis Flipped on Save (Critical Bug)**:
   - **Root Cause**: PDF user coordinate space has origin $(0, 0)$ at the **bottom-left** of the page with $Y$ increasing **upwards**. Canvas coordinate space has origin $(0, 0)$ at the **top-left** with $Y$ increasing **downwards**.
   - `pdf.rs` was writing $Y_{\text{canvas}}$ directly into the PDF content stream without transforming $Y_{\text{pdf}} = H_{\text{page}} - Y_{\text{canvas}}$, causing exported ink strokes to appear upside-down and shifted to the bottom of the page in PDF viewers.
2. **System Lag / Performance**:
   - `redrawTiles` in `app.js` is called synchronously on every scroll/pan frame without `requestAnimationFrame` debouncing or tile fetching throttling.
3. **Improper Page Positioning in Dual View**:
   - In `redrawTilesForPane` and `drawPageBackground`, page bounds are computed relative to pane coordinates, but horizontal centering within the pane half is missing when zoomed out.
4. **No Independent Per-Pane Zoom**:
   - `viewport.js` maintains `zoom` and `rightZoom`, but mouse wheel and trackpad pinch events only update a single global zoom level regardless of which pane the cursor is over.
5. **Split View Page Selection UI**:
   - When enabling split view, there are no explicit Left/Right page dropdowns or navigation controls on the toolbar to set left and right sheets explicitly.

---

## Scope & Proposed Changes

### Component 1 — PDF Save Coordinate Transformation Fix (`inkwell-core/src/pdf.rs`)

#### [MODIFY] [`pdf.rs`](file:///d:/Own%20Programs/InkWell/inkwell/crates/inkwell-core/src/pdf.rs)

1. Obtain page height $H$ from page dictionary `/MediaBox` or `/CropBox` (default $842.0$ pt if absent).
2. In `emit_group`:
   - Transform bounding box:
     $$Y_{\text{min, pdf}} = H - Y_{\text{max, canvas}}, \quad Y_{\text{max, pdf}} = H - Y_{\text{min, canvas}}$$
   - Transform path command coordinates:
     - `MoveTo((x, H - y))`
     - `LineTo((x, H - y))`
     - `CurveTo([(x0, H - y0), (x1, H - y1), (x2, H - y2)])`
   - Transform `/InkList` centreline points:
     $$(x, H - y)$$

---

### Component 2 — Independent Per-Pane Zoom & Pan (`inkwell-app/src/js/viewport.js`)

#### [MODIFY] [`viewport.js`](file:///d:/Own%20Programs/InkWell/inkwell-app/src/js/viewport.js)

1. Update wheel/zoom handlers to target the active pane (`left` or `right`):
   - If cursor is over right pane in split mode, modify `viewport.rightZoom`, `viewport.rightPanX`, `viewport.rightPanY`.
   - Otherwise modify `viewport.zoom`, `viewport.panX`, `viewport.panY`.
2. Add toolbar zoom indicator/controls for the active pane.

---

### Component 3 — Dual-Pane Page Centering & Alignment (`inkwell-app/src/js/app.js`)

#### [MODIFY] [`app.js`](file:///d:/Own%20Programs/InkWell/inkwell-app/src/js/app.js)

1. In `drawPageBackground` and `redrawTilesForPane`, center the document page horizontally within its pane bounds when page width is less than pane width.
2. Debounce `redrawTiles` using `requestAnimationFrame` and a 16ms render throttle so panning and zooming run smoothly at 60+ FPS.

---

### Component 4 — Explicit Split View Page Selector UI (`inkwell-app/src/index.html` & `app.js`)

#### [MODIFY] [`index.html`](file:///d:/Own%20Programs/InkWell/inkwell-app/src/index.html) & [`app.js`](file:///d:/Own%20Programs/InkWell/inkwell-app/src/js/app.js)

1. Add explicit Left Page ($1..N$) and Right Page ($1..N$) dropdowns/steppers to the bottom navigation bar when Split View is active.
2. Allow instant switching of left pane and right pane pages independently.

---

## Verification Plan

### Automated Tests
```powershell
# Rust unit & integration tests
& "$env:USERPROFILE\.cargo\bin\cargo.exe" test --workspace --manifest-path inkwell/Cargo.toml
```

### Manual Verification
1. Open PDF, draw strokes near the top of Page 3 (e.g. text "ABCDEFG").
2. Click **Save (Ctrl+S)** and open the saved PDF in Microsoft Edge / Chrome / Adobe Reader.
3. Verify annotations are right-side up, correctly positioned at the top of Page 3, and match the app display 100%.
4. Toggle Split View, zoom in on the right pane independently of the left pane.
5. Verify page selector allows choosing Left Page vs Right Page cleanly.
