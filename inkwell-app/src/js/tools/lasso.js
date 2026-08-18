/* ============================================================================
 * tools/lasso.js — Freeform Lasso & 8-Handle Matrix Transform Engine for Inkwell
 * Selects strokes, images, and text objects; performs 2D affine scaling and dragging.
 * ========================================================================== */

import { state, emit } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as overlays from '../render/overlays.js';
import * as compositor from '../render/compositor.js';

export function onLassoDown(e, ptWorld, screenPt, pane, viewport) {
  const handle = overlays.getSelectionHandleAt(screenPt[0], screenPt[1], state, viewport, pane);
  
  if (handle) {
    // Begin interactive transform (move or resize handle)
    state.transformMode = handle.name;
    state.transformStartPt = [ptWorld[0], ptWorld[1]];
    state.transformInitialBounds = overlays.getSelectionBounds(state, viewport);
    state.transformInitialStrokes = (state.selectedStrokes || []).map(s => ({
      id: s.id,
      points: s.points.map(p => ({ ...p })),
    }));
    state.transformInitialImages = (state.selectedImages || []).map(img => ({
      id: img.id,
      x: img.x,
      y: img.y,
      width: img.width,
      height: img.height,
    }));
    state.transformInitialTextObjects = (state.selectedTextObjects || []).map(t => ({
      id: t.id,
      x: t.x,
      y: t.y,
      fontSize: t.fontSize || 16,
    }));
    return;
  }

  // Click on single object to select
  const clickedObj = findObjectAtWorld(ptWorld[0], ptWorld[1], viewport);
  if (clickedObj) {
    if (clickedObj.type === 'stroke') {
      state.selectedStrokes = [clickedObj.item];
      state.selectedImages = [];
      state.selectedTextObjects = [];
    } else if (clickedObj.type === 'image') {
      state.selectedStrokes = [];
      state.selectedImages = [clickedObj.item];
      state.selectedTextObjects = [];
    } else if (clickedObj.type === 'text') {
      state.selectedStrokes = [];
      state.selectedImages = [];
      state.selectedTextObjects = [clickedObj.item];
    }
    state.lassoPath = null;
    emit('selectionChanged', { strokes: state.selectedStrokes, images: state.selectedImages, textObjects: state.selectedTextObjects });
    compositor.redrawAll();
    return;
  }

  // Start new freeform polygon lasso loop
  state.lassoPath = [[ptWorld[0], ptWorld[1]]];
  state.selectedStrokes = [];
  state.selectedImages = [];
  state.selectedTextObjects = [];
  emit('selectionCleared', {});
  compositor.redrawAll();
}

export function onLassoMove(e, ptWorld, screenPt, pane, viewport) {
  if (state.transformMode && state.transformStartPt && state.transformInitialBounds) {
    applyInteractiveTransform(ptWorld, viewport);
    compositor.redrawAll();
    return;
  }

  if (state.lassoPath) {
    state.lassoPath.push([ptWorld[0], ptWorld[1]]);
    compositor.redrawAll();
  }
}

export function onLassoUp(e, viewport) {
  if (state.transformMode) {
    // Commit the transform transaction to history
    documentOps.commitTransform({
      initialStrokes: state.transformInitialStrokes || [],
      initialImages: state.transformInitialImages || [],
      initialTextObjects: state.transformInitialTextObjects || [],
    }, { recordHistory: true });

    state.transformMode = null;
    state.transformStartPt = null;
    state.transformInitialBounds = null;
    compositor.redrawAll();
    return;
  }

  if (state.lassoPath && state.lassoPath.length > 2) {
    selectObjectsInPolygon(state.lassoPath, viewport);
    state.lassoPath = null;
    compositor.redrawAll();
  } else {
    state.lassoPath = null;
    compositor.redrawAll();
  }
}

export function selectAllOnCurrentPage(viewport) {
  if (!viewport) return;
  const activeSheet = viewport.getActivePageInView(state.drawingPane || 'left');
  state.selectedStrokes = (state.strokes || []).filter(s => !s.deleted && s.sheet === activeSheet);
  state.selectedImages = (state.images || []).filter(img => !img.deleted && img.sheet === activeSheet);
  state.selectedTextObjects = (state.textObjects || []).filter(t => !t.deleted && t.sheet === activeSheet);

  emit('selectionChanged', { strokes: state.selectedStrokes, images: state.selectedImages, textObjects: state.selectedTextObjects });
  compositor.redrawAll();
}

function selectObjectsInPolygon(polygon, viewport) {
  const selectedStrokes = [];
  const selectedImages = [];
  const selectedTexts = [];

  for (const s of (state.strokes || [])) {
    if (s.deleted) continue;
    const pl = viewport.getPageLayout(s.sheet || 0);
    for (const pt of s.points) {
      const wx = pl.x + pt.x;
      const wy = pl.y + pt.y;
      if (pointInPolygon(wx, wy, polygon)) {
        selectedStrokes.push(s);
        break;
      }
    }
  }

  for (const img of (state.images || [])) {
    if (img.deleted) continue;
    const pl = viewport.getPageLayout(img.sheet || 0);
    const cx = pl.x + img.x + img.width / 2;
    const cy = pl.y + img.y + img.height / 2;
    if (pointInPolygon(cx, cy, polygon)) {
      selectedImages.push(img);
    }
  }

  for (const t of (state.textObjects || [])) {
    if (t.deleted) continue;
    const pl = viewport.getPageLayout(t.sheet || 0);
    const cx = pl.x + t.x + (t.width || 120) / 2;
    const cy = pl.y + t.y + (t.height || 32) / 2;
    if (pointInPolygon(cx, cy, polygon)) {
      selectedTexts.push(t);
    }
  }

  state.selectedStrokes = selectedStrokes;
  state.selectedImages = selectedImages;
  state.selectedTextObjects = selectedTexts;

  emit('selectionChanged', { strokes: selectedStrokes, images: selectedImages, textObjects: selectedTexts });
}

function pointInPolygon(px, py, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > py) !== (yj > py)) &&
                      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function findObjectAtWorld(wx, wy, viewport, radius = 10) {
  const pageCoord = viewport.worldToPage(wx, wy);
  const targetSheet = pageCoord.sheet;
  const pl = viewport.getPageLayout(targetSheet);

  // 1. Text objects
  for (let i = (state.textObjects || []).length - 1; i >= 0; i--) {
    const t = state.textObjects[i];
    if (t.deleted || t.sheet !== targetSheet) continue;
    const x0 = pl.x + t.x;
    const y0 = pl.y + t.y;
    const w = t.width || 120;
    const h = t.height || 32;
    if (wx >= x0 - 4 && wx <= x0 + w + 4 && wy >= y0 - 4 && wy <= y0 + h + 4) {
      return { type: 'text', item: t };
    }
  }

  // 2. Images
  for (let i = (state.images || []).length - 1; i >= 0; i--) {
    const img = state.images[i];
    if (img.deleted || img.sheet !== targetSheet) continue;
    const x0 = pl.x + img.x;
    const y0 = pl.y + img.y;
    if (wx >= x0 && wx <= x0 + img.width && wy >= y0 && wy <= y0 + img.height) {
      return { type: 'image', item: img };
    }
  }

  // 3. Strokes
  for (let i = (state.strokes || []).length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (s.deleted || s.sheet !== targetSheet) continue;
    for (const pt of s.points) {
      const sx = pl.x + pt.x;
      const sy = pl.y + pt.y;
      if (Math.hypot(wx - sx, wy - sy) <= radius + (pt.w || 2)) {
        return { type: 'stroke', item: s };
      }
    }
  }

  return null;
}

function applyInteractiveTransform(ptWorld, viewport) {
  const dx = ptWorld[0] - state.transformStartPt[0];
  const dy = ptWorld[1] - state.transformStartPt[1];
  const ib = state.transformInitialBounds;
  if (!ib) return;

  const mode = state.transformMode;

  if (mode === 'move') {
    // Translation
    if (state.transformInitialStrokes) {
      for (const init of state.transformInitialStrokes) {
        const s = (state.strokes || []).find(st => st.id === init.id);
        if (s) {
          s.points = init.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
          if (window.Ink && typeof window.Ink.getPath2D === 'function') {
            s._cachedPath2D = window.Ink.getPath2D(s);
          }
        }
      }
    }

    if (state.transformInitialImages) {
      for (const init of state.transformInitialImages) {
        const img = (state.images || []).find(im => im.id === init.id);
        if (img) {
          img.x = init.x + dx;
          img.y = init.y + dy;
        }
      }
    }

    if (state.transformInitialTextObjects) {
      for (const init of state.transformInitialTextObjects) {
        const t = (state.textObjects || []).find(txt => txt.id === init.id);
        if (t) {
          t.x = init.x + dx;
          t.y = init.y + dy;
        }
      }
    }
  } else {
    // 8-handle Scaling
    let scaleX = 1.0;
    let scaleY = 1.0;
    let originX = ib.x0;
    let originY = ib.y0;

    if (mode.includes('e')) {
      scaleX = Math.max(0.1, (ib.width + dx) / ib.width);
      originX = ib.x0;
    } else if (mode.includes('w')) {
      scaleX = Math.max(0.1, (ib.width - dx) / ib.width);
      originX = ib.x1;
    }

    if (mode.includes('s')) {
      scaleY = Math.max(0.1, (ib.height + dy) / ib.height);
      originY = ib.y0;
    } else if (mode.includes('n')) {
      scaleY = Math.max(0.1, (ib.height - dy) / ib.height);
      originY = ib.y1;
    }

    if (state.transformInitialStrokes) {
      for (const init of state.transformInitialStrokes) {
        const s = (state.strokes || []).find(st => st.id === init.id);
        if (s) {
          const pl = viewport.getPageLayout(s.sheet || 0);
          s.points = init.points.map(p => {
            const wx = pl.x + p.x;
            const wy = pl.y + p.y;
            const nwx = originX + (wx - originX) * scaleX;
            const nwy = originY + (wy - originY) * scaleY;
            return { ...p, x: nwx - pl.x, y: nwy - pl.y };
          });
          if (window.Ink && typeof window.Ink.getPath2D === 'function') {
            s._cachedPath2D = window.Ink.getPath2D(s);
          }
        }
      }
    }

    if (state.transformInitialImages) {
      for (const init of state.transformInitialImages) {
        const img = (state.images || []).find(im => im.id === init.id);
        if (img) {
          const pl = viewport.getPageLayout(img.sheet || 0);
          const wx = pl.x + init.x;
          const wy = pl.y + init.y;
          const nwx = originX + (wx - originX) * scaleX;
          const nwy = originY + (wy - originY) * scaleY;
          img.x = nwx - pl.x;
          img.y = nwy - pl.y;
          img.width = Math.max(20, init.width * scaleX);
          img.height = Math.max(20, init.height * scaleY);
        }
      }
    }
  }
}
