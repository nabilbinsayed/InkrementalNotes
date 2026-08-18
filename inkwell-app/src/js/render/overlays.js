/* ============================================================================
 * render/overlays.js — Visual Overlays Engine for Inkwell
 * Renders selection bounding boxes, 8-handle grips, laser trails, and shapes.
 * Read-only with respect to document state.
 * ========================================================================== */

export function getSelectionBounds(state, viewport) {
  if (!state || !viewport) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasItems = false;

  if (state.selectedStrokes && state.selectedStrokes.length) {
    for (const s of state.selectedStrokes) {
      if (s.deleted) continue;
      const pl = viewport.getPageLayout(s.sheet || 0);
      for (const pt of s.points) {
        const wx = pl.x + pt.x;
        const wy = pl.y + pt.y;
        minX = Math.min(minX, wx); minY = Math.min(minY, wy);
        maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy);
        hasItems = true;
      }
    }
  }

  if (state.selectedImages && state.selectedImages.length) {
    for (const img of state.selectedImages) {
      if (img.deleted) continue;
      const pl = viewport.getPageLayout(img.sheet || 0);
      const wx0 = pl.x + img.x;
      const wy0 = pl.y + img.y;
      const wx1 = wx0 + img.width;
      const wy1 = wy0 + img.height;
      minX = Math.min(minX, wx0); minY = Math.min(minY, wy0);
      maxX = Math.max(maxX, wx1); maxY = Math.max(maxY, wy1);
      hasItems = true;
    }
  }

  if (state.selectedTextObjects && state.selectedTextObjects.length) {
    for (const t of state.selectedTextObjects) {
      if (t.deleted) continue;
      const pl = viewport.getPageLayout(t.sheet || 0);
      const wx0 = pl.x + t.x;
      const wy0 = pl.y + t.y;
      const wx1 = wx0 + (t.width || 120);
      const wy1 = wy0 + (t.height || 32);
      minX = Math.min(minX, wx0); minY = Math.min(minY, wy0);
      maxX = Math.max(maxX, wx1); maxY = Math.max(maxY, wy1);
      hasItems = true;
    }
  }

  if (!hasItems || minX >= maxX || minY >= maxY) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY, width: maxX - minX, height: maxY - minY };
}

export function getSelectionHandleAt(screenX, screenY, state, viewport, pane = 'left') {
  const bounds = getSelectionBounds(state, viewport);
  if (!bounds) return null;
  const pad = 6;
  const [sx0, sy0] = viewport.worldToScreen(bounds.x0 - pad, bounds.y0 - pad, pane);
  const [sx1, sy1] = viewport.worldToScreen(bounds.x1 + pad, bounds.y1 + pad, pane);
  const midSx = (sx0 + sx1) / 2;
  const midSy = (sy0 + sy1) / 2;

  const handles = [
    { name: 'nw', x: sx0, y: sy0, cursor: 'nwse-resize' },
    { name: 'n',  x: midSx, y: sy0, cursor: 'ns-resize' },
    { name: 'ne', x: sx1, y: sy0, cursor: 'nesw-resize' },
    { name: 'e',  x: sx1, y: midSy, cursor: 'ew-resize' },
    { name: 'se', x: sx1, y: sy1, cursor: 'nwse-resize' },
    { name: 's',  x: midSx, y: sy1, cursor: 'ns-resize' },
    { name: 'sw', x: sx0, y: sy1, cursor: 'nesw-resize' },
    { name: 'w',  x: sx0, y: midSy, cursor: 'ew-resize' },
  ];

  for (const h of handles) {
    if (Math.hypot(screenX - h.x, screenY - h.y) <= 8) {
      return h;
    }
  }

  if (screenX >= sx0 && screenX <= sx1 && screenY >= sy0 && screenY <= sy1) {
    return { name: 'move', cursor: 'move' };
  }
  return null;
}

export function drawSelectionOverlay(ctx, state, viewport, dpr, pane = 'left') {
  if (!ctx || !state || !viewport) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  // 1. Freeform lasso drawing in progress
  if (state.lassoPath && state.lassoPath.length > 1) {
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.9)';
    ctx.fillStyle = 'rgba(99, 102, 241, 0.12)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);

    ctx.beginPath();
    const [startSx, startSy] = viewport.worldToScreen(state.lassoPath[0][0], state.lassoPath[0][1], pane);
    ctx.moveTo(startSx, startSy);
    for (let i = 1; i < state.lassoPath.length; i++) {
      const [sx, sy] = viewport.worldToScreen(state.lassoPath[i][0], state.lassoPath[i][1], pane);
      ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // 2. Selection bounding box with 8 transform handles
  const bounds = getSelectionBounds(state, viewport);
  if (bounds) {
    const pad = 6;
    const [sx0, sy0] = viewport.worldToScreen(bounds.x0 - pad, bounds.y0 - pad, pane);
    const [sx1, sy1] = viewport.worldToScreen(bounds.x1 + pad, bounds.y1 + pad, pane);

    ctx.strokeStyle = '#6366f1';
    ctx.fillStyle = 'rgba(99, 102, 241, 0.06)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    ctx.fill();
    ctx.stroke();

    const midSx = (sx0 + sx1) / 2;
    const midSy = (sy0 + sy1) / 2;
    const handlePts = [
      [sx0, sy0], [midSx, sy0], [sx1, sy0],
      [sx1, midSy], [sx1, sy1], [midSx, sy1],
      [sx0, sy1], [sx0, midSy]
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
  }

  ctx.restore();
}

export function drawShapeOverlay(ctx, state, viewport, dpr, pane = 'left', clipPaneFn) {
  if (!ctx || !state || !state.shapeStart || !state.shapeEnd || !viewport) return;
  const [sx0, sy0] = viewport.worldToScreen(state.shapeStart[0], state.shapeStart[1], pane);
  const [sx1, sy1] = viewport.worldToScreen(state.shapeEnd[0], state.shapeEnd[1], pane);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  if (typeof clipPaneFn === 'function') clipPaneFn(ctx, pane);

  const color = `rgb(${state.color.map(v => Math.round(v * 255)).join(',')})`;
  ctx.strokeStyle = color;
  ctx.lineWidth = state.baseWidth || 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.beginPath();

  if (state.shapeKind === 'rect') {
    ctx.rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  } else if (state.shapeKind === 'ellipse') {
    ctx.ellipse((sx0 + sx1) / 2, (sy0 + sy1) / 2,
                Math.abs(sx1 - sx0) / 2, Math.abs(sy1 - sy0) / 2, 0, 0, Math.PI * 2);
  } else if (state.shapeKind === 'line') {
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
  }

  ctx.stroke();
  ctx.restore();
}

export function drawLaserPointer(ctx, state, viewport, dpr, pane = 'left') {
  if (!ctx || !state || !state.laserPoints || !state.laserPoints.length || !viewport) return;
  const now = Date.now();
  const maxAge = 1200; // ms

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  for (let i = 0; i < state.laserPoints.length; i++) {
    const pt = state.laserPoints[i];
    const age = now - pt.time;
    if (age > maxAge) continue;
    const life = 1 - (age / maxAge);

    const [sx, sy] = viewport.worldToScreen(pt.x, pt.y, pane);
    const radius = Math.max(2, (pt.radius || 6) * life);

    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(239, 68, 68, ${life * 0.85})`;
    ctx.shadowColor = '#ef4444';
    ctx.shadowBlur = 12 * life;
    ctx.fill();
  }

  ctx.restore();
}

export function drawZoomIndicator(ctx, viewport, dpr, panes, paneBoundsFn) {
  if (!ctx || !viewport) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'bottom';

  for (const pane of panes) {
    const bounds = typeof paneBoundsFn === 'function' ? paneBoundsFn(pane) : { x: 0, y: 0, width: 800, height: 600 };
    const z = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
    const pct = Math.round(z * 100) + '%';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(pct, bounds.x + bounds.width - 12, bounds.y + bounds.height - 8);
  }
  ctx.restore();
}
