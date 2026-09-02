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
      const halfW = (s.base_width || 2) / 2;
      for (const pt of s.points) {
        const w = (pt.w !== undefined ? pt.w / 2 : halfW) || halfW;
        const wx = pl.x + pt.x;
        const wy = pl.y + pt.y;
        minX = Math.min(minX, wx - w); minY = Math.min(minY, wy - w);
        maxX = Math.max(maxX, wx + w); maxY = Math.max(maxY, wy + w);
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

  if (!hasItems) return null;
  if (minX >= maxX) { minX -= 4; maxX += 4; }
  if (minY >= maxY) { minY -= 4; maxY += 4; }
  return { x0: minX, y0: minY, x1: maxX, y1: maxY, width: maxX - minX, height: maxY - minY };
}

export function getSelectionHandleAt(screenX, screenY, state, viewport, pane = 'left') {
  const bounds = getSelectionBounds(state, viewport);
  if (!bounds) return null;
  const pad = 6;
  const [sx0, sy0] = viewport.worldToScreen(bounds.x0 - pad, bounds.y0 - pad, pane);
  const [sx1, sy1] = viewport.worldToScreen(bounds.x1 + pad, bounds.y1 + pad, pane);
  const minX = Math.min(sx0, sx1);
  const maxX = Math.max(sx0, sx1);
  const minY = Math.min(sy0, sy1);
  const maxY = Math.max(sy0, sy1);
  const midSx = (minX + maxX) / 2;
  const midSy = (minY + maxY) / 2;

  const rotStalkLen = 26;
  const rotHandleY = minY - rotStalkLen;

  // 1. Rotation handle
  if (Math.hypot(screenX - midSx, screenY - rotHandleY) <= 14) {
    return { name: 'rotate', x: midSx, y: rotHandleY, cursor: 'grab' };
  }

  const handles = [
    { name: 'nw', x: minX, y: minY, cursor: 'nwse-resize' },
    { name: 'n',  x: midSx, y: minY, cursor: 'ns-resize' },
    { name: 'ne', x: maxX, y: minY, cursor: 'nesw-resize' },
    { name: 'e',  x: maxX, y: midSy, cursor: 'ew-resize' },
    { name: 'se', x: maxX, y: maxY, cursor: 'nwse-resize' },
    { name: 's',  x: midSx, y: maxY, cursor: 'ns-resize' },
    { name: 'sw', x: minX, y: maxY, cursor: 'nesw-resize' },
    { name: 'w',  x: minX, y: midSy, cursor: 'ew-resize' },
  ];

  // 2. Corner & edge resize handles
  for (const h of handles) {
    if (Math.hypot(screenX - h.x, screenY - h.y) <= 14) {
      return h;
    }
  }

  // 3. Move area: full interior plus boundary padding
  if (screenX >= minX - 4 && screenX <= maxX + 4 && screenY >= minY - 4 && screenY <= maxY + 4) {
    return { name: 'move', cursor: 'move' };
  }
  return null;
}

export function drawSelectionOverlay(ctx, state, viewport, dpr, pane = 'left') {
  if (!ctx || !state || !viewport) return;
  if (state.activeTool !== 'lasso') return;

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

  // 2. Selection bounding box with 8 transform handles + rotation handle
  const bounds = getSelectionBounds(state, viewport);
  if (bounds) {
    const pad = 6;
    const [sx0, sy0] = viewport.worldToScreen(bounds.x0 - pad, bounds.y0 - pad, pane);
    const [sx1, sy1] = viewport.worldToScreen(bounds.x1 + pad, bounds.y1 + pad, pane);
    const minX = Math.min(sx0, sx1);
    const maxX = Math.max(sx0, sx1);
    const minY = Math.min(sy0, sy1);
    const maxY = Math.max(sy0, sy1);
    const midSx = (minX + maxX) / 2;
    const midSy = (minY + maxY) / 2;

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

    // If currently rotating, display real-time angle badge
    if (state.transformMode === 'rotate' && state.transformCurrentAngle !== null && state.transformCurrentAngle !== undefined) {
      let deg = Math.round(state.transformCurrentAngle * 180 / Math.PI) % 360;
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

export function drawPersistentTextSelectionHighlights(ctx, state, viewport, dpr, panes, clipPaneFn) {
  if (!ctx || !state || !state.textSelection || !state.textSelection.rects || !state.textSelection.rects.length || !viewport) return;
  const sel = state.textSelection;
  const paneList = panes || ['left'];

  for (const pane of paneList) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    if (typeof clipPaneFn === 'function') clipPaneFn(ctx, pane);
    const pl = viewport.getPageLayout(sel.sheet);
    if (pl) {
      for (const r of sel.rects) {
        const [sx0, sy0] = viewport.worldToScreen(pl.x + r.rect[0], pl.y + r.rect[1], pane);
        const [sx1, sy1] = viewport.worldToScreen(pl.x + r.rect[2], pl.y + r.rect[3], pane);
        const w = sx1 - sx0;
        const h = sy1 - sy0;

        ctx.fillStyle = 'rgba(56, 189, 248, 0.32)';
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.78)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(sx0, sy0, w, h, 2);
        } else {
          ctx.rect(sx0, sy0, w, h);
        }
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

export function drawSearchHighlights(ctx, state, viewport, dpr, panes, clipPaneFn) {
  if (!ctx || !state || !state.searchQuery || !state.searchResults || !state.searchResults.length || !viewport) return;
  const activeMatch = state.searchResults[state.activeSearchMatch];
  const paneList = panes || ['left'];

  for (const pane of paneList) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    if (typeof clipPaneFn === 'function') clipPaneFn(ctx, pane);

    for (let i = 0; i < state.searchResults.length; i++) {
      const res = state.searchResults[i];
      const pl = viewport.getPageLayout(res.pageIndex || 0);
      if (!pl) continue;
      const [sx0, sy0] = viewport.worldToScreen(pl.x + res.rect[0], pl.y + res.rect[1], pane);
      const [sx1, sy1] = viewport.worldToScreen(pl.x + res.rect[2], pl.y + res.rect[3], pane);

      const isCurrent = (res === activeMatch);
      ctx.fillStyle = isCurrent ? 'rgba(234, 179, 8, 0.65)' : 'rgba(250, 204, 21, 0.35)';
      ctx.strokeStyle = isCurrent ? '#ca8a04' : 'rgba(202, 138, 4, 0.5)';
      ctx.lineWidth = 1;

      ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
      ctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    }
    ctx.restore();
  }
}

