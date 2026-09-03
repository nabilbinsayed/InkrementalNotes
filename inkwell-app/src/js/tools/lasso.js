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
    // Begin interactive transform (move, rotate, or resize handle)
    state.transformMode = handle.name;
    state.transformStartPt = [ptWorld[0], ptWorld[1]];
    state.transformInitialBounds = overlays.getSelectionBounds(state, viewport);
    const ib = state.transformInitialBounds;
    if (ib) {
      state.transformCenterPt = [(ib.x0 + ib.x1) / 2, (ib.y0 + ib.y1) / 2];
      state.transformStartAngle = Math.atan2(ptWorld[1] - state.transformCenterPt[1], ptWorld[0] - state.transformCenterPt[0]);
    }
    state.transformCurrentAngle = 0;
    state.transformInitialStrokes = (state.selectedStrokes || []).map(s => ({
      id: s.id,
      stroke: s,
      points: s.points.map(p => ({ ...p })),
      bbox: s.bbox ? [...s.bbox] : null,
    }));
    state.transformInitialImages = (state.selectedImages || []).map(img => ({
      id: img.id,
      image: img,
      x: img.x,
      y: img.y,
      width: img.width,
      height: img.height,
    }));
    state.transformInitialTextObjects = (state.selectedTextObjects || []).map(t => ({
      id: t.id,
      textObj: t,
      x: t.x,
      y: t.y,
      fontSize: t.fontSize || 16,
    }));
    for (const s of (state.selectedStrokes || [])) {
      if (typeof s.getPath2D === 'function') {
        s.getPath2D();
      } else if (!s._cachedPath2D && window.Ink && typeof window.Ink.getPath2D === 'function') {
        s._cachedPath2D = window.Ink.getPath2D(s);
      }
      s._origBbox = s.bbox;
      s.bbox = [-999999, -999999, -999998, -999998];
    }
    compositor.redrawAll();
    renderWetTransform(pane, viewport);
    return;
  }

  // Click on single object to select (or begin moving already selected object)
  const clickedObj = findObjectAtWorld(ptWorld[0], ptWorld[1], viewport);
  if (clickedObj) {
    const isAlreadySelected = (clickedObj.type === 'stroke' && (state.selectedStrokes || []).includes(clickedObj.item)) ||
                              (clickedObj.type === 'image' && (state.selectedImages || []).includes(clickedObj.item)) ||
                              (clickedObj.type === 'text' && (state.selectedTextObjects || []).includes(clickedObj.item));
    if (isAlreadySelected) {
      // Start moving existing selection
      state.transformMode = 'move';
      state.transformStartPt = [ptWorld[0], ptWorld[1]];
      state.transformInitialBounds = overlays.getSelectionBounds(state, viewport);
      const ib = state.transformInitialBounds;
      if (ib) {
        state.transformCenterPt = [(ib.x0 + ib.x1) / 2, (ib.y0 + ib.y1) / 2];
      }
      state.transformCurrentAngle = 0;
      state.transformInitialStrokes = (state.selectedStrokes || []).map(s => ({
        id: s.id,
        stroke: s,
        points: s.points.map(p => ({ ...p })),
        bbox: s.bbox ? [...s.bbox] : null,
      }));
      state.transformInitialImages = (state.selectedImages || []).map(img => ({
        id: img.id,
        image: img,
        x: img.x,
        y: img.y,
        width: img.width,
        height: img.height,
      }));
      state.transformInitialTextObjects = (state.selectedTextObjects || []).map(t => ({
        id: t.id,
        textObj: t,
        x: t.x,
        y: t.y,
        fontSize: t.fontSize || 16,
      }));
      for (const s of (state.selectedStrokes || [])) {
        if (typeof s.getPath2D === 'function') {
          s.getPath2D();
        } else if (!s._cachedPath2D && window.Ink && typeof window.Ink.getPath2D === 'function') {
          s._cachedPath2D = window.Ink.getPath2D(s);
        }
        s._origBbox = s.bbox;
        s.bbox = [-999999, -999999, -999998, -999998];
      }
      compositor.redrawAll();
      renderWetTransform(pane, viewport);
      return;
    }

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
    compositor.clearWet();
    compositor.redrawAll();
    return;
  }

  // Start new freeform polygon lasso loop
  state.lassoPath = [[ptWorld[0], ptWorld[1]]];
  state.selectedStrokes = [];
  state.selectedImages = [];
  state.selectedTextObjects = [];
  emit('selectionCleared', {});
  compositor.clearWet();
  compositor.redrawAll();
}

export function onLassoMove(e, ptWorld, screenPt, pane, viewport) {
  if (state.transformMode && state.transformStartPt && state.transformInitialBounds) {
    applyInteractiveTransform(ptWorld, viewport, e);
    renderWetTransform(pane, viewport);
    return;
  }

  if (state.lassoPath) {
    state.lassoPath.push([ptWorld[0], ptWorld[1]]);
    compositor.redrawAll();
  }
}

export function onLassoUp(e, viewport) {
  if (state.transformMode) {
    const mode = state.transformMode;
    const dx = state.transformLastDx || 0;
    const dy = state.transformLastDy || 0;
    const currentAngle = state.transformCurrentAngle || 0;
    const scaleX = state.transformLastScaleX !== undefined ? state.transformLastScaleX : 1.0;
    const scaleY = state.transformLastScaleY !== undefined ? state.transformLastScaleY : 1.0;
    const originX = state.transformLastOriginX !== undefined ? state.transformLastOriginX : (state.transformInitialBounds ? state.transformInitialBounds.x0 : 0);
    const originY = state.transformLastOriginY !== undefined ? state.transformLastOriginY : (state.transformInitialBounds ? state.transformInitialBounds.y0 : 0);
    const center = state.transformCenterPt;

    // Restore temporary bbox culling override
    for (const s of (state.selectedStrokes || [])) {
      if (s._origBbox !== undefined) {
        s.bbox = s._origBbox;
        delete s._origBbox;
      }
    }

    // 1. Bake the affine transform into stroke points once
    if (state.transformInitialStrokes) {
      for (const init of state.transformInitialStrokes) {
        const s = init.stroke || (state.strokes || []).find(st => String(st.id) === String(init.id));
        if (s) {
          if (mode === 'move') {
            s.points = init.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
          } else if (mode === 'rotate') {
            if (center) {
              const cosA = Math.cos(currentAngle);
              const sinA = Math.sin(currentAngle);
              const pl = viewport.getPageLayout(s.sheet || 0);
              s.points = init.points.map(p => {
                const wx = pl.x + p.x;
                const wy = pl.y + p.y;
                const rx = center[0] + (wx - center[0]) * cosA - (wy - center[1]) * sinA;
                const ry = center[1] + (wx - center[0]) * sinA + (cy - center[1]) * cosA;
                return { ...p, x: rx - pl.x, y: ry - pl.y };
              });
            }
          } else {
            // Scale
            const pl = viewport.getPageLayout(s.sheet || 0);
            s.points = init.points.map(p => {
              const wx = pl.x + p.x;
              const wy = pl.y + p.y;
              const nwx = originX + (wx - originX) * scaleX;
              const nwy = originY + (wy - originY) * scaleY;
              return { ...p, x: nwx - pl.x, y: nwy - pl.y };
            });
          }
        }
      }
    }

    // Bake images
    if (state.transformInitialImages) {
      for (const init of state.transformInitialImages) {
        const img = init.image || (state.images || []).find(im => String(im.id) === String(init.id));
        if (img) {
          if (mode === 'move') {
            img.x = init.x + dx;
            img.y = init.y + dy;
          } else if (mode === 'rotate') {
            if (center) {
              const cosA = Math.cos(currentAngle);
              const sinA = Math.sin(currentAngle);
              const pl = viewport.getPageLayout(img.sheet || 0);
              const cx = pl.x + init.x + init.width / 2;
              const cy = pl.y + init.y + init.height / 2;
              const rcx = center[0] + (cx - center[0]) * cosA - (cy - center[1]) * sinA;
              const rcy = center[1] + (cx - center[0]) * sinA + (cy - center[1]) * cosA;
              img.x = rcx - pl.x - init.width / 2;
              img.y = rcy - pl.y - init.height / 2;
            }
          } else {
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

    // Bake text objects
    if (state.transformInitialTextObjects) {
      for (const init of state.transformInitialTextObjects) {
        const t = init.textObj || (state.textObjects || []).find(txt => String(txt.id) === String(init.id));
        if (t) {
          if (mode === 'move') {
            t.x = init.x + dx;
            t.y = init.y + dy;
          } else if (mode === 'rotate') {
            if (center) {
              const cosA = Math.cos(currentAngle);
              const sinA = Math.sin(currentAngle);
              const pl = viewport.getPageLayout(t.sheet || 0);
              const cx = pl.x + init.x + (t.width || 120) / 2;
              const cy = pl.y + init.y + (t.height || 32) / 2;
              const rcx = center[0] + (cx - center[0]) * cosA - (cy - center[1]) * sinA;
              const rcy = center[1] + (cx - center[0]) * sinA + (cy - center[1]) * cosA;
              t.x = rcx - pl.x - (t.width || 120) / 2;
              t.y = rcy - pl.y - (t.height || 32) / 2;
            }
          }
        }
      }
    }

    // 2. Recompute exact bboxes for all moved strokes and invalidate _cachedPath2D
    for (const s of (state.selectedStrokes || [])) {
      if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
        s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
      }
      s._cachedPath2D = null;
    }
    documentOps.rebuildStrokesBySheet();

    // 3. Commit the transform transaction to history with both initial and final geometry
    documentOps.commitTransform({
      initialStrokes: state.transformInitialStrokes || [],
      initialImages: state.transformInitialImages || [],
      initialTextObjects: state.transformInitialTextObjects || [],
      finalStrokes: (state.selectedStrokes || []).map(s => ({ id: s.id, points: s.points.map(p => ({ ...p })) })),
      finalImages: (state.selectedImages || []).map(img => ({ id: img.id, x: img.x, y: img.y, width: img.width, height: img.height })),
      finalTextObjects: (state.selectedTextObjects || []).map(t => ({ id: t.id, x: t.x, y: t.y, fontSize: t.fontSize })),
    }, { recordHistory: true });

    state.transformMode = null;
    state.transformStartPt = null;
    state.transformInitialBounds = null;
    state.transformCenterPt = null;
    state.transformStartAngle = null;
    state.transformCurrentAngle = null;
    state.transformLastDx = null;
    state.transformLastDy = null;
    state.transformLastScaleX = null;
    state.transformLastScaleY = null;
    state.transformLastOriginX = null;
    state.transformLastOriginY = null;
    state.transformInitialStrokes = null;
    state.transformInitialImages = null;
    state.transformInitialTextObjects = null;

    compositor.clearWet();
    compositor.redrawAll();
    return;
  }

  if (state.lassoPath && state.lassoPath.length > 2) {
    selectObjectsInPolygon(state.lassoPath, viewport);
    state.lassoPath = null;
    compositor.clearWet();
    compositor.redrawAll();
  } else {
    state.lassoPath = null;
    compositor.clearWet();
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

function applyInteractiveTransform(ptWorld, viewport, e) {
  const dx = ptWorld[0] - state.transformStartPt[0];
  const dy = ptWorld[1] - state.transformStartPt[1];
  const ib = state.transformInitialBounds;
  if (!ib) return;

  const mode = state.transformMode;

  if (mode === 'move') {
    state.transformLastDx = dx;
    state.transformLastDy = dy;
    state.transformCurrentAngle = 0;
    state.transformLastScaleX = 1.0;
    state.transformLastScaleY = 1.0;
  } else if (mode === 'rotate') {
    const center = state.transformCenterPt;
    if (!center) return;
    let dAngle = Math.atan2(ptWorld[1] - center[1], ptWorld[0] - center[0]) - state.transformStartAngle;
    
    // Hold Shift to snap rotation to 15-degree increments
    if (e && e.shiftKey) {
      const snap = Math.PI / 12; // 15 degrees
      dAngle = Math.round(dAngle / snap) * snap;
    }
    state.transformCurrentAngle = dAngle;
    state.transformLastDx = 0;
    state.transformLastDy = 0;
    state.transformLastScaleX = 1.0;
    state.transformLastScaleY = 1.0;
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

    state.transformLastDx = 0;
    state.transformLastDy = 0;
    state.transformCurrentAngle = 0;
    state.transformLastScaleX = scaleX;
    state.transformLastScaleY = scaleY;
    state.transformLastOriginX = originX;
    state.transformLastOriginY = originY;
  }
}

function renderWetTransform(pane, viewport) {
  compositor.clearWet();
  const { wctx } = compositor.getContexts();
  if (!wctx || !viewport) return;

  const ib = state.transformInitialBounds;
  if (!ib) return;

  const mode = state.transformMode;
  const dx = state.transformLastDx || 0;
  const dy = state.transformLastDy || 0;
  const currentAngle = state.transformCurrentAngle || 0;
  const currentScaleX = state.transformLastScaleX !== undefined ? state.transformLastScaleX : 1.0;
  const currentScaleY = state.transformLastScaleY !== undefined ? state.transformLastScaleY : 1.0;

  const center = state.transformCenterPt || [(ib.x0 + ib.x1) / 2, (ib.y0 + ib.y1) / 2];
  let originX = center[0];
  let originY = center[1];
  if (mode !== 'move' && mode !== 'rotate' && state.transformLastOriginX !== undefined) {
    originX = state.transformLastOriginX;
    originY = state.transformLastOriginY;
  }

  const activePane = pane || state.drawingPane || 'left';
  const z = (activePane === 'right' && viewport.splitMode) ? viewport.rightZoom : viewport.zoom;

  // Render selected strokes on wet canvas with 2D canvas matrix transformations
  const strokesBySheet = new Map();
  for (const s of (state.selectedStrokes || [])) {
    const sheet = s.sheet || 0;
    if (!strokesBySheet.has(sheet)) strokesBySheet.set(sheet, []);
    strokesBySheet.get(sheet).push(s);
  }

  for (const [sheet, sheetStrokes] of strokesBySheet.entries()) {
    const pl = viewport.getPageLayout(sheet);
    const [psx, psy] = viewport.worldToScreen(pl.x, pl.y, activePane);

    const cx = (mode === 'move') ? 0 : (originX - pl.x);
    const cy = (mode === 'move') ? 0 : (originY - pl.y);

    wctx.save();
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.scale(state.dpr, state.dpr);
    compositor.clipToPane(wctx, activePane);

    wctx.translate(psx, psy);
    wctx.scale(z, z);

    if (mode === 'move') {
      wctx.translate(dx, dy);
    } else {
      wctx.translate(cx, cy);
      wctx.rotate(currentAngle);
      wctx.scale(currentScaleX, currentScaleY);
      wctx.translate(-cx, -cy);
    }

    for (const s of sheetStrokes) {
      const isHighlighter = s.kind === 'highlighter';
      if (isHighlighter) {
        wctx.save();
        wctx.globalCompositeOperation = 'multiply';
        wctx.globalAlpha = 0.42;
      }
      wctx.fillStyle = s.cssColor || `rgb(${s.rgb.map(v => Math.round(v * 255)).join(',')})`;
      const p2d = (typeof s.getPath2D === 'function')
        ? s.getPath2D()
        : (s._cachedPath2D || (window.Ink && window.Ink.getPath2D && window.Ink.getPath2D(s)));
      if (p2d) {
        wctx.fill(p2d);
      }
      if (isHighlighter) {
        wctx.restore();
      }
    }
    wctx.restore();
  }

  // Draw selection bounding box and handles with affine transform
  drawTransformedSelectionOverlay(wctx, viewport, activePane, ib, mode, dx, dy, currentAngle, currentScaleX, currentScaleY, originX, originY);
}

function drawTransformedSelectionOverlay(ctx, viewport, pane, ib, mode, dx, dy, currentAngle, scaleX, scaleY, originX, originY) {
  const pad = 6;
  const [sx0, sy0] = viewport.worldToScreen(ib.x0 - pad, ib.y0 - pad, pane);
  const [sx1, sy1] = viewport.worldToScreen(ib.x1 + pad, ib.y1 + pad, pane);
  const minX = Math.min(sx0, sx1);
  const maxX = Math.max(sx0, sx1);
  const minY = Math.min(sy0, sy1);
  const maxY = Math.max(sy0, sy1);
  const midSx = (minX + maxX) / 2;
  const midSy = (minY + maxY) / 2;

  const [origSx, origSy] = viewport.worldToScreen(originX, originY, pane);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(state.dpr, state.dpr);
  compositor.clipToPane(ctx, pane);

  const z = (pane === 'right' && viewport.splitMode) ? viewport.rightZoom : viewport.zoom;

  if (mode === 'move') {
    ctx.translate(dx * z, dy * z);
  } else {
    ctx.translate(origSx, origSy);
    ctx.rotate(currentAngle);
    ctx.scale(scaleX, scaleY);
    ctx.translate(-origSx, -origSy);
  }

  // Bounding rectangle
  ctx.strokeStyle = '#6366f1';
  ctx.fillStyle = 'rgba(99, 102, 241, 0.06)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.rect(minX, minY, maxX - minX, maxY - minY);
  ctx.fill();
  ctx.stroke();

  // Rotation stalk and handle
  const rotStalkLen = 26;
  const rotHandleY = minY - rotStalkLen;

  ctx.save();
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(midSx, minY);
  ctx.lineTo(midSx, rotHandleY);
  ctx.stroke();

  ctx.fillStyle = '#6366f1';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(midSx, rotHandleY, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (mode === 'rotate' && currentAngle !== null && currentAngle !== undefined) {
    let deg = Math.round(currentAngle * 180 / Math.PI) % 360;
    if (deg < 0) deg += 360;
    ctx.font = 'bold 11px Inter, -apple-system, system-ui, sans-serif';
    const label = `${deg}°`;
    const txtW = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(midSx - txtW / 2 - 6, rotHandleY - 24, txtW + 12, 18, 4);
    } else {
      ctx.rect(midSx - txtW / 2 - 6, rotHandleY - 24, txtW + 12, 18);
    }
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, midSx, rotHandleY - 15);
  }
  ctx.restore();

  // 8 transform handles
  const handlePts = [
    [minX, minY], [midSx, minY], [maxX, minY],
    [maxX, midSy], [maxX, maxY], [midSx, maxY],
    [minX, maxY], [minX, midSy]
  ];

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#4f46e5';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);

  for (const [hx, hy] of handlePts) {
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}
