/* ============================================================================
 * app.js — Inkwell production web app controller
 * ========================================================================== */

const $ = id => document.getElementById(id);

const state = {
  activeTool: 'pen',     // 'pen', 'highlighter', 'eraser', 'lasso', 'ruler',
                          // 'rect', 'ellipse', 'laser'
  prevTool: 'pen',        // restored after spring-loaded key release
  springKey: null,        // which key is spring-held right now
  color: [0.08, 0.09, 0.14],
  baseWidth: 1.6,         // Fine elegant line width matching Xournal++ / Excalidraw
  strokes: [],           // {id, kind, rgb, base_width, points[], deleted}
  selectedStrokes: [],
  undoStack: [],
  redoStack: [],
  cur: null,
  dpr: 1,
  samplesCount: 0,
  isErasing: false,
  leftSheet: 0,       // active PDF page index for left pane
  rightSheet: 0,      // active PDF page index for right pane
  get currentSheet() { return paneSheet(state.drawingPane || 'left'); },
  set currentSheet(v) {
    const pane = state.drawingPane || 'left';
    if (pane === 'right' && viewport.splitMode) state.rightSheet = v;
    else state.leftSheet = v;
  },
  pageInfos: [],         // [{page_index, width_pt, height_pt}, ...]
  shapeStart: null,
  shapeEnd: null,
  shapeKind: null,       // 'rect' | 'ellipse' | 'line'
  lassoStart: null,
  lassoRect: null,
  laserPos: null,
  laserTimer: null,
  streamline: null,
  drawingPane: 'left',
};

function paneSheet(pane = 'left') {
  if (pane === 'right' && viewport.splitMode) return state.rightSheet;
  return state.leftSheet;
}

let tilesCanvas, dryCanvas, wetCanvas;
let tctx, dctx, wctx;
let viewport;

const tileCache = new Map();
const tilesPending = new Map();

function paneBounds(pane = 'left') {
  const width = tilesCanvas.width / state.dpr;
  const height = tilesCanvas.height / state.dpr;
  if (!viewport || !viewport.splitMode) return { x: 0, y: 0, width, height };
  const half = width / 2;
  return pane === 'right' ? { x: half, y: 0, width: half, height } : { x: 0, y: 0, width: half, height };
}

function visiblePanes() {
  return viewport && viewport.splitMode ? ['left', 'right'] : ['left'];
}

function paneForEvent(e) {
  const r = wetCanvas.getBoundingClientRect();
  return viewport.splitMode && e.clientX - r.left > r.width / 2 ? 'right' : 'left';
}

function paneTransform(ctx, pane) {
  const isRight = pane === 'right' && viewport.splitMode;
  ctx.translate(isRight ? viewport.rightPanX : viewport.panX, isRight ? viewport.rightPanY : viewport.panY);
  ctx.scale(isRight ? viewport.rightZoom : viewport.zoom, isRight ? viewport.rightZoom : viewport.zoom);
}

function clipToPane(ctx, pane) {
  const bounds = paneBounds(pane);
  ctx.beginPath();
  ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.clip();
}

async function fetchTile(page, rect, px) {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
                 (window.__TAURI__ && window.__TAURI__.invoke);
  if (!invoke) return null;
  const key = `${page}:${rect.join(',')}:${px}`;
  if (tileCache.has(key)) return { key, data: tileCache.get(key) };
  if (tilesPending.has(key)) return tilesPending.get(key);

  const task = (async () => {
    try {
    const raw = await invoke('render_tile', { page, rect, px });
    const expectedBytes = px * px * 3;
    if (!raw || raw.length !== expectedBytes) {
      throw new Error(`Invalid tile buffer: expected ${expectedBytes} RGB bytes, got ${raw ? raw.length : 0}`);
    }
    const imgData = new ImageData(px, px);
    for (let i = 0; i < px * px; i++) {
      imgData.data[i * 4 + 0] = raw[i * 3 + 0];
      imgData.data[i * 4 + 1] = raw[i * 3 + 1];
      imgData.data[i * 4 + 2] = raw[i * 3 + 2];
      imgData.data[i * 4 + 3] = 255;
    }
    // ImageData is not a CanvasImageSource, so it cannot be passed to
    // drawImage() directly. Materialise it in a tiny canvas before caching.
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = px;
    tileCanvas.height = px;
    tileCanvas.getContext('2d').putImageData(imgData, 0, 0);
    tileCache.set(key, tileCanvas);
    return { key, data: tileCanvas };
    } catch (err) {
      console.warn('render_tile error:', err);
      return null;
    } finally {
      tilesPending.delete(key);
    }
  })();
  tilesPending.set(key, task);
  return task;
}

// ---- Page background (white paper rect with red border like Xournal++) ----
function drawPageBackground(pane = 'left') {
  if (!state.pageInfos.length) return;
  const sheetIdx = paneSheet(pane);
  const pi = state.pageInfos[sheetIdx];
  if (!pi) return;
  const [sx0, sy0] = viewport.worldToScreen(0, 0, pane);
  const [sx1, sy1] = viewport.worldToScreen(pi.width_pt, pi.height_pt, pane);

  tctx.save();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.scale(state.dpr, state.dpr);
  clipToPane(tctx, pane);
  // Paper drop shadow
  tctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  tctx.shadowBlur = 20;
  tctx.shadowOffsetY = 6;
  tctx.fillStyle = '#ffffff';
  tctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);

  tctx.shadowBlur = 0;
  tctx.shadowOffsetY = 0;
  // Red page border matching Xournal++
  tctx.strokeStyle = '#ef4444';
  tctx.lineWidth = 1.5;
  tctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  tctx.restore();
}

async function redrawTiles() {
  const drawEpoch = ++redrawTiles.epoch;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, tilesCanvas.width, tilesCanvas.height);

  for (const pane of visiblePanes()) drawPageBackground(pane);

  if (!state.pageInfos.length) return;

  await Promise.all(visiblePanes().map(pane => {
    const sheetIdx = paneSheet(pane);
    const pi = state.pageInfos[sheetIdx];
    return pi ? redrawTilesForPane(pane, pi, sheetIdx, drawEpoch) : Promise.resolve();
  }));
}
redrawTiles.epoch = 0;

async function redrawTilesForPane(pane, pi, sheetIdx, drawEpoch) {
  const bounds = paneBounds(pane);

  const [wx0, wy0] = viewport.screenToWorld(bounds.x, bounds.y, pane);
  const [wx1, wy1] = viewport.screenToWorld(bounds.x + bounds.width, bounds.y + bounds.height, pane);
  const rx0 = Math.max(0, wx0), ry0 = Math.max(0, wy0);
  const rx1 = Math.min(pi.width_pt, wx1), ry1 = Math.min(pi.height_pt, wy1);
  if (rx1 <= rx0 || ry1 <= ry0) return;

  // The current Rust tile protocol produces square pixel buffers. Request a
  // square in document space too; otherwise portrait pages are copied into
  // the corner of a square and look blank or badly distorted when blitted.
  const side = Math.max(rx1 - rx0, ry1 - ry0);
  const tileRect = [rx0, ry0, Math.min(pi.width_pt, rx0 + side), Math.min(pi.height_pt, ry0 + side)];
  const zoom = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
  const px = Math.min(2048, Math.round(side * zoom * state.dpr));
  if (px < 4) return;

  const result = await fetchTile(sheetIdx, tileRect, px);
  if (!result || drawEpoch !== redrawTiles.epoch) return;

  const [sx0, sy0] = viewport.worldToScreen(tileRect[0], tileRect[1], pane);
  const [sx1, sy1] = viewport.worldToScreen(tileRect[2], tileRect[3], pane);
  const [pageX0, pageY0] = viewport.worldToScreen(0, 0, pane);
  const [pageX1, pageY1] = viewport.worldToScreen(pi.width_pt, pi.height_pt, pane);
  tctx.save();
  tctx.scale(state.dpr, state.dpr);
  clipToPane(tctx, pane);
  tctx.beginPath();
  tctx.rect(pageX0, pageY0, pageX1 - pageX0, pageY1 - pageY0);
  tctx.clip();
  tctx.drawImage(result.data, sx0, sy0, sx1 - sx0, sy1 - sy0);
  tctx.restore();
}

function makeCtx(canvas) {
  return canvas.getContext('2d', { desynchronized: true, alpha: true });
}

function resize() {
  const host = $('stage');
  const r = host.getBoundingClientRect();
  state.dpr = Math.max(1, window.devicePixelRatio || 1);

  for (const c of [tilesCanvas, dryCanvas, wetCanvas]) {
    c.width = Math.round(r.width * state.dpr);
    c.height = Math.round(r.height * state.dpr);
    c.style.width = r.width + 'px';
    c.style.height = r.height + 'px';
  }

  tctx = makeCtx(tilesCanvas);
  dctx = makeCtx(dryCanvas);
  wctx = makeCtx(wetCanvas);

  for (const ctx of [tctx, dctx, wctx]) ctx.scale(state.dpr, state.dpr);
  for (const pane of visiblePanes()) drawPageBackground(pane);
  redrawTiles();
  redrawAll();
}

function redrawAll() {
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, dryCanvas.width, dryCanvas.height);
  dctx.scale(state.dpr, state.dpr);
  for (const pane of visiblePanes()) {
    const sheetIdx = paneSheet(pane);
    dctx.save();
    clipToPane(dctx, pane);
    paneTransform(dctx, pane);
    for (const s of state.strokes) {
      if (!s.deleted && s.sheet === sheetIdx) Ink.drawStroke(dctx, s);
    }
    dctx.restore();
  }
}

function drawCommittedStroke(stroke) {
  for (const pane of visiblePanes()) {
    if (stroke.sheet !== paneSheet(pane)) continue;
    dctx.save();
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.scale(state.dpr, state.dpr);
    clipToPane(dctx, pane);
    paneTransform(dctx, pane);
    Ink.drawStroke(dctx, stroke);
    dctx.restore();
  }
}

function clearWet() {
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.clearRect(0, 0, wetCanvas.width, wetCanvas.height);
  wctx.scale(state.dpr, state.dpr);
}

function localXY(e, pane = state.drawingPane || paneForEvent(e)) {
  const r = wetCanvas.getBoundingClientRect();
  return viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top, pane);
}

// ---- Page navigation ----
function goToPage(i, pane = viewport.activePane || 'left') {
  if (i < 0 || i >= state.pageInfos.length) return;
  if (pane === 'right' && viewport.splitMode) {
    state.rightSheet = i;
  } else {
    state.leftSheet = i;
  }
  tileCache.clear(); // clear so new page's tiles are fetched fresh
  const pi = state.pageInfos[i];
  centerPageInPanes(pi);
  updatePageUI();
  redrawTiles();
  redrawAll();
}

function centerPageInPanes(pi = state.pageInfos[state.currentSheet]) {
  if (!pi) return;
  const left = paneBounds('left');
  const zoom = Math.min(left.width / pi.width_pt, left.height / pi.height_pt) * 0.9;
  viewport.zoom = Math.max(0.2, Math.min(16.0, zoom));
  viewport.panX = left.x + (left.width - pi.width_pt * viewport.zoom) / 2;
  viewport.panY = left.y + (left.height - pi.height_pt * viewport.zoom) / 2;
  if (viewport.splitMode) {
    const right = paneBounds('right');
    viewport.rightZoom = viewport.zoom;
    viewport.rightPanX = right.x + (right.width - pi.width_pt * viewport.rightZoom) / 2;
    viewport.rightPanY = right.y + (right.height - pi.height_pt * viewport.rightZoom) / 2;
  }
}

function updatePageUI() {
  const total = state.pageInfos.length;
  const activeSheet = paneSheet(viewport.activePane || 'left');
  const cur = activeSheet + 1;
  const paneTag = viewport.splitMode ? ` (${(viewport.activePane || 'left').toUpperCase()})` : '';
  $('pageNum').textContent = total ? `${cur} / ${total}${paneTag}` : '—';
  $('btnPrev').disabled = activeSheet <= 0;
  $('btnNext').disabled = activeSheet >= total - 1;
}

// ---- Eraser (stroke-erase by proximity) ----
function eraseStrokesAt(e) {
  const pane = state.drawingPane || paneForEvent(e);
  const targetSheet = paneSheet(pane);
  const [wx, wy] = localXY(e, pane);
  const radius = 10 / viewport.zoom;
  let erased = [];

  for (const s of state.strokes) {
    if (s.deleted || s.sheet !== targetSheet) continue;
    for (const pt of s.points) {
      if (Math.hypot(pt.x - wx, pt.y - wy) < radius + pt.w / 2) {
        s.deleted = true;
        erased.push(s);
        break;
      }
    }
  }

  if (erased.length) {
    state.undoStack.push({ type: 'erase', strokes: erased });
    state.redoStack = [];
    redrawAll();
    if (window.__TAURI__) {
      window.__TAURI__.core.invoke('erase_strokes_near', {
        sheet: state.currentSheet, px: wx, py: wy, radius,
      }).catch(err => console.warn('erase_strokes_near failed:', err));
    }
  }
}

// ---- consume (wet layer drawing) ----
function consume(e) {
  if (!state.cur) return;
  const [x, y] = localXY(e, state.drawingPane);
  const p = e.pressure > 0 ? e.pressure : 0.5;
  const smoothed = state.streamline.filter(x, y, p);
  const prev = state.cur.last;
  const pt = state.cur.push(smoothed.x, smoothed.y, smoothed.p, e.timeStamp);
  if (!pt) return;
  state.samplesCount++;

  wctx.save();
  clipToPane(wctx, state.drawingPane);
  paneTransform(wctx, state.drawingPane);
  wctx.fillStyle = `rgb(${state.cur.rgb.map(v => Math.round(v * 255)).join(',')})`;
  if (state.cur.kind === 'highlighter') {
    wctx.globalCompositeOperation = 'multiply';
    wctx.globalAlpha = 0.5;
  }
  if (prev) Ink.drawSegment(wctx, prev, pt);
  else Ink.drawDot(wctx, pt);
  wctx.restore();
  updateStats(e.pointerType);
}

// ---- Shape overlay helpers ----
function drawShapeOverlay() {
  if (!state.shapeStart || !state.shapeEnd) return;
  const [sx0, sy0] = viewport.worldToScreen(state.shapeStart[0], state.shapeStart[1], state.drawingPane);
  const [sx1, sy1] = viewport.worldToScreen(state.shapeEnd[0], state.shapeEnd[1], state.drawingPane);
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.scale(state.dpr, state.dpr);
  clipToPane(wctx, state.drawingPane);
  const color = `rgb(${state.color.map(v => Math.round(v * 255)).join(',')})`;
  wctx.strokeStyle = color;
  wctx.lineWidth = state.baseWidth;
  wctx.lineCap = 'round';
  wctx.lineJoin = 'round';
  wctx.setLineDash([]);
  wctx.beginPath();
  if (state.shapeKind === 'rect') {
    wctx.rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  } else if (state.shapeKind === 'ellipse') {
    wctx.ellipse((sx0 + sx1) / 2, (sy0 + sy1) / 2,
                 Math.abs(sx1 - sx0) / 2, Math.abs(sy1 - sy0) / 2, 0, 0, Math.PI * 2);
  }
  wctx.stroke();
  wctx.restore();
}

// ---- Lasso overlay ----
function drawLassoOverlay() {
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.scale(state.dpr, state.dpr);

  if (state.lassoRect) {
    const { x0, y0, x1, y1 } = state.lassoRect;
    const [sx0, sy0] = viewport.worldToScreen(x0, y0, state.drawingPane);
    const [sx1, sy1] = viewport.worldToScreen(x1, y1, state.drawingPane);
    wctx.strokeStyle = 'rgba(79,70,229,0.9)';
    wctx.fillStyle = 'rgba(79,70,229,0.12)';
    wctx.lineWidth = 1.5;
    wctx.setLineDash([6, 4]);
    wctx.beginPath();
    wctx.rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    wctx.fill();
    wctx.stroke();
  } else if (state.selectedStrokes && state.selectedStrokes.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of state.selectedStrokes) {
      if (s.deleted) continue;
      for (const pt of s.points) {
        minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
      }
    }
    if (minX < maxX && minY < maxY) {
      const [sx0, sy0] = viewport.worldToScreen(minX - 4, minY - 4, state.drawingPane);
      const [sx1, sy1] = viewport.worldToScreen(maxX + 4, maxY + 4, state.drawingPane);
      wctx.strokeStyle = '#6366f1';
      wctx.fillStyle = 'rgba(99,102,241,0.08)';
      wctx.lineWidth = 2;
      wctx.setLineDash([6, 4]);
      wctx.beginPath();
      wctx.rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
      wctx.fill();
      wctx.stroke();

      wctx.fillStyle = '#ffffff';
      wctx.strokeStyle = '#4f46e5';
      wctx.lineWidth = 2;
      wctx.setLineDash([]);
      for (const [hx, hy] of [[sx0, sy0], [sx1, sy0], [sx1, sy1], [sx0, sy1]]) {
        wctx.beginPath();
        wctx.arc(hx, hy, 5, 0, Math.PI * 2);
        wctx.fill();
        wctx.stroke();
      }
    }
  }
  wctx.restore();
}

// ---- Laser pointer ----
function drawLaser() {
  if (!state.laserPos) return;
  const [sx, sy] = viewport.worldToScreen(state.laserPos[0], state.laserPos[1], state.drawingPane);
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.scale(state.dpr, state.dpr);
  clipToPane(wctx, state.drawingPane);
  wctx.beginPath();
  wctx.arc(sx, sy, 8, 0, Math.PI * 2);
  wctx.fillStyle = 'rgba(239,68,68,0.15)';
  wctx.fill();
  wctx.beginPath();
  wctx.arc(sx, sy, 4, 0, Math.PI * 2);
  wctx.fillStyle = 'rgba(239,68,68,0.9)';
  wctx.fill();
  wctx.restore();
}

// ---- Commit a shape as stroke samples ----
async function commitShape(kind, wx0, wy0, wx1, wy1) {
  let samples;
  if (kind === 'rect') {
    samples = [
      [wx0, wy0], [wx1, wy0], [wx1, wy1], [wx0, wy1], [wx0, wy0],
    ];
  } else { // ellipse: 32-point approximation
    const cx = (wx0 + wx1) / 2, cy = (wy0 + wy1) / 2;
    const rx = Math.abs(wx1 - wx0) / 2, ry = Math.abs(wy1 - wy0) / 2;
    samples = Array.from({ length: 33 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
    });
  }
  const pts = samples.map(([x, y], i) => ({
    x, y, w: state.baseWidth, p: 0.7, t: i * 10,
  }));
  const stroke = { id: crypto.randomUUID(), kind: 'pen', rgb: state.color,
                   base_width: state.baseWidth, points: pts,
                   sheet: state.currentSheet, deleted: false };
  state.strokes.push(stroke);
  state.undoStack.push({ type: 'add', stroke });
  state.redoStack = [];
  redrawAll();
  if (window.__TAURI__) {
    const payload = samples.map(([x, y], i) => ({ x, y, pressure: 0.7, t_ms: i * 10 }));
    window.__TAURI__.core.invoke('commit_stroke', {
      sheet: state.currentSheet, tool: 'pen', rgb: state.color,
      baseWidth: state.baseWidth, samples: payload,
    }).catch(err => console.warn('shape commit_stroke failed:', err));
  }
}

// ---- Pointer handlers ----
function onDown(e) {
  if (e.button !== 0 && e.pointerType !== 'pen') return;
  try { wetCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  $('toolbar').classList.add('pen-down');

  state.drawingPane = paneForEvent(e);
  viewport.activePane = state.drawingPane;
  const [wx, wy] = localXY(e, state.drawingPane);

  if (state.activeTool === 'laser') {
    state.laserPos = [wx, wy];
    clearWet(); drawLaser();
    return;
  }

  if (state.activeTool === 'eraser') {
    state.isErasing = true;
    eraseStrokesAt(e);
    return;
  }

  if (state.activeTool === 'lasso') {
    state.lassoStart = [wx, wy];
    state.lassoRect = { x0: wx, y0: wy, x1: wx, y1: wy };
    return;
  }

  if (state.activeTool === 'ruler') {
    state.shapeKind = 'line';
    state.shapeStart = [wx, wy];
    state.shapeEnd = [wx, wy];
    return;
  }

  if (state.activeTool === 'rect') {
    state.shapeKind = 'rect';
    state.shapeStart = [wx, wy];
    state.shapeEnd = [wx, wy];
    return;
  }

  if (state.activeTool === 'ellipse') {
    state.shapeKind = 'ellipse';
    state.shapeStart = [wx, wy];
    state.shapeEnd = [wx, wy];
    return;
  }

  const isHighlighter = state.activeTool === 'highlighter';
  state.cur = new Ink.Stroke({
    kind: state.activeTool,
    rgb: state.color,
    baseWidth: isHighlighter ? 12.0 : state.baseWidth,
    smoothing: false,
  });
  state.streamline = new Ink.Streamline();
  consume(e);
  e.preventDefault();
}

function onMove(e) {
  const [wx, wy] = localXY(e, state.drawingPane);

  if (state.activeTool === 'laser') {
    state.laserPos = [wx, wy];
    clearWet(); drawLaser();
    return;
  }

  if (state.isErasing) { eraseStrokesAt(e); return; }

  if (state.activeTool === 'lasso' && state.lassoStart) {
    state.lassoRect = { x0: state.lassoStart[0], y0: state.lassoStart[1], x1: wx, y1: wy };
    clearWet();
    drawLassoOverlay();
    return;
  }

  if ((state.activeTool === 'ruler' || state.activeTool === 'rect' ||
       state.activeTool === 'ellipse') && state.shapeStart) {
    let ex = wx, ey = wy;
    if (e.shiftKey && state.activeTool === 'ruler') {
      // snap to 45° increments
      const dx = wx - state.shapeStart[0], dy = wy - state.shapeStart[1];
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      ex = state.shapeStart[0] + Math.cos(angle) * len;
      ey = state.shapeStart[1] + Math.sin(angle) * len;
    } else if (e.shiftKey) {
      // square / circle constraint
      const dx = Math.abs(wx - state.shapeStart[0]);
      const dy = Math.abs(wy - state.shapeStart[1]);
      const s = Math.max(dx, dy);
      ex = state.shapeStart[0] + Math.sign(wx - state.shapeStart[0]) * s;
      ey = state.shapeStart[1] + Math.sign(wy - state.shapeStart[1]) * s;
    }
    state.shapeEnd = [ex, ey];
    clearWet();
    if (state.shapeKind === 'line') {
      // Reuse ruler overlay draw logic inline
      const [sx0, sy0] = viewport.worldToScreen(state.shapeStart[0], state.shapeStart[1], state.drawingPane);
      const [sx1, sy1] = viewport.worldToScreen(ex, ey, state.drawingPane);
      wctx.save();
      wctx.setTransform(1, 0, 0, 1, 0, 0);
      wctx.scale(state.dpr, state.dpr);
      clipToPane(wctx, state.drawingPane);
      wctx.strokeStyle = `rgb(${state.color.map(v => Math.round(v * 255)).join(',')})`;
      wctx.lineWidth = state.baseWidth;
      wctx.lineCap = 'round';
      wctx.setLineDash([]);
      wctx.beginPath(); wctx.moveTo(sx0, sy0); wctx.lineTo(sx1, sy1); wctx.stroke();
      wctx.restore();
    } else {
      drawShapeOverlay();
    }
    return;
  }

  if (!state.cur) return;
  if (e.getCoalescedEvents) {
    const co = e.getCoalescedEvents();
    (co.length ? co : [e]).forEach(c => consume(c));
  } else {
    consume(e);
  }
  e.preventDefault();
}

async function onUp(e) {
  $('toolbar').classList.remove('pen-down');

  if (state.activeTool === 'laser') {
    clearLaser();
    return;
  }

  state.isErasing = false;

  // Lasso Select commit
  if (state.activeTool === 'lasso' && state.lassoRect) {
    const { x0, y0, x1, y1 } = state.lassoRect;
    const rx0 = Math.min(x0, x1), rx1 = Math.max(x0, x1);
    const ry0 = Math.min(y0, y1), ry1 = Math.max(y0, y1);
    let selected = [];
    if (Math.abs(rx1 - rx0) > 3 || Math.abs(ry1 - ry0) > 3) {
      for (const s of state.strokes) {
        if (s.deleted || s.sheet !== state.currentSheet) continue;
        if (s.points.some(pt => pt.x >= rx0 && pt.x <= rx1 && pt.y >= ry0 && pt.y <= ry1)) {
          selected.push(s);
        }
      }
    }
    state.selectedStrokes = selected;
    state.lassoStart = null;
    state.lassoRect = null;
    clearWet();
    drawLassoOverlay();
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  // Shape commit
  if ((state.activeTool === 'ruler' || state.activeTool === 'rect' ||
       state.activeTool === 'ellipse') && state.shapeStart && state.shapeEnd) {
    const [ax, ay] = state.shapeStart, [bx, by] = state.shapeEnd;
    clearWet();
    if (Math.hypot(bx - ax, by - ay) > 2) {
      if (state.shapeKind === 'line') {
        const rulerStroke = new Ink.Stroke({ kind: 'pen', rgb: state.color, baseWidth: state.baseWidth });
        rulerStroke.push(ax, ay, 0.7, 0);
        rulerStroke.push(bx, by, 0.7, 50);
        const s = { ...rulerStroke, sheet: state.currentSheet, deleted: false };
        // Ink.Stroke is a class; clone its points
        const finishedStroke = {
          id: rulerStroke.id, kind: rulerStroke.kind, rgb: rulerStroke.rgb,
          base_width: rulerStroke.base_width, points: rulerStroke.points.slice(),
          sheet: state.currentSheet, deleted: false,
        };
        state.strokes.push(finishedStroke);
        state.undoStack.push({ type: 'add', stroke: finishedStroke });
        state.redoStack = [];
        redrawAll();
        if (window.__TAURI__) {
          window.__TAURI__.core.invoke('commit_stroke', {
            sheet: state.currentSheet, tool: 'pen', rgb: state.color,
            baseWidth: state.baseWidth,
            samples: [{ x: ax, y: ay, pressure: 0.7, t_ms: 0 },
                      { x: bx, y: by, pressure: 0.7, t_ms: 50 }],
          }).catch(err => console.warn('ruler commit failed:', err));
        }
      } else {
        await commitShape(state.shapeKind, ax, ay, bx, by);
      }
    }
    state.shapeStart = null; state.shapeEnd = null; state.shapeKind = null;
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  if (!state.cur) return;

  const finishedStroke = state.cur;
  const strokeRec = {
    id: finishedStroke.id, kind: finishedStroke.kind, rgb: finishedStroke.rgb,
    base_width: finishedStroke.base_width, points: finishedStroke.points.slice(),
    sheet: state.currentSheet, deleted: false,
  };
  state.strokes.push(strokeRec);
  state.undoStack.push({ type: 'add', stroke: strokeRec });
  state.redoStack = [];

  if (window.__TAURI__) {
    try {
      const samplesPayload = finishedStroke.points.map(pt => ({
        x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
      }));
      await window.__TAURI__.core.invoke('commit_stroke', {
        sheet: state.currentSheet,
        tool: finishedStroke.kind,
        rgb: finishedStroke.rgb,
        baseWidth: finishedStroke.base_width,
        samples: samplesPayload,
      });
    } catch (err) { console.warn('Failed to commit stroke to Rust core:', err); }
  }

  drawCommittedStroke(strokeRec);
  state.cur = null;
  clearWet();
  try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
}

function clearLaser() {
  state.laserPos = null;
  clearTimeout(state.laserTimer);
  clearWet();
}

function updateStats(pointerType) {
  $('inputStats').innerHTML = `
    <div>Pointer: ${pointerType || 'pen'}</div>
    <div>Samples: ${state.samplesCount}</div>
    <div>Strokes: ${state.strokes.filter(s => !s.deleted).length}</div>
  `;
}

// ---- Tool selection ----
const TOOL_BTNS = ['btnPen', 'btnHighlighter', 'btnEraser', 'btnLasso',
                   'btnRuler', 'btnRect', 'btnEllipse', 'btnLaser'];
function setTool(tool) {
  state.activeTool = tool;
  TOOL_BTNS.forEach(id => $(id) && $(id).classList.remove('active'));
  const toolBtnMap = {
    pen: 'btnPen', highlighter: 'btnHighlighter', eraser: 'btnEraser',
    lasso: 'btnLasso', ruler: 'btnRuler', rect: 'btnRect',
    ellipse: 'btnEllipse', laser: 'btnLaser',
  };
  const btnId = toolBtnMap[tool];
  if (btnId) $(btnId) && $(btnId).classList.add('active');
}

// ---- Undo / Redo ----
function undo() {
  if (!state.undoStack.length) return;
  const op = state.undoStack.pop();
  if (op.type === 'add') {
    op.stroke.deleted = true;
    state.redoStack.push(op);
  } else if (op.type === 'erase') {
    for (const s of op.strokes) s.deleted = false;
    state.redoStack.push(op);
  }
  redrawAll();
}

function redo() {
  if (!state.redoStack.length) return;
  const op = state.redoStack.pop();
  if (op.type === 'add') {
    op.stroke.deleted = false;
    state.undoStack.push(op);
  } else if (op.type === 'erase') {
    for (const s of op.strokes) s.deleted = true;
    state.undoStack.push(op);
  }
  redrawAll();
}

// ---- Out-of-bounds check ----
function checkOutOfBounds(stroke) {
  if (!state.pageInfos[state.currentSheet]) return;
  const pi = state.pageInfos[state.currentSheet];
  const oob = stroke.points.some(pt => pt.x < 0 || pt.x > pi.width_pt || pt.y < 0 || pt.y > pi.height_pt);
  if (oob) {
    const banner = $('oobBanner');
    if (banner) {
      banner.classList.remove('hidden');
      clearTimeout(state.oobTimer);
      state.oobTimer = setTimeout(() => banner.classList.add('hidden'), 3000);
    }
  }
}

// ---- Insert Blank Page ----
async function insertBlankPage() {
  const newIndex = state.pageInfos.length;
  const width_pt = 595.0, height_pt = 842.0;
  if (window.__TAURI__) {
    try {
      const pageInfo = await window.__TAURI__.core.invoke('insert_blank_page', {
        index: newIndex, widthPt: width_pt, heightPt: height_pt,
      });
      state.pageInfos.push(pageInfo);
    } catch (err) {
      console.warn('insert_blank_page failed in backend:', err);
      state.pageInfos.push({ page_index: newIndex, width_pt, height_pt });
    }
  } else {
    state.pageInfos.push({ page_index: newIndex, width_pt, height_pt });
  }
  updatePageUI();
  goToPage(newIndex);
}

// ---- Split View & Sidebar ----
function toggleSplitView() {
  const isSplit = viewport.toggleSplitMode();
  if (isSplit && state.rightSheet === state.leftSheet && state.pageInfos.length > 1) {
    state.rightSheet = Math.min(state.leftSheet + 1, state.pageInfos.length - 1);
  }
  $('stage').classList.toggle('split-view', isSplit);
  centerPageInPanes();
  $('btnSplit') && $('btnSplit').classList.toggle('active', isSplit);
  redrawTiles();
  redrawAll();
}

function toggleSidebar() {
  const sidebar = $('sidebar');
  if (!sidebar) return;
  const collapsed = sidebar.classList.toggle('collapsed');
  $('btnToggleSidebar') && $('btnToggleSidebar').classList.toggle('active', !collapsed);
  $('btnExpandSidebar') && $('btnExpandSidebar').classList.toggle('hidden', !collapsed);
  resize();
}

// ---- Command Palette ----
const COMMANDS = [
  { id: 'open_pdf', title: 'Open PDF Document', category: 'File', shortcut: 'Ctrl+O', action: () => $('btnOpen').click() },
  { id: 'save_pdf', title: 'Save PDF Document', category: 'File', shortcut: 'Ctrl+S', action: () => $('btnSave').click() },
  { id: 'insert_blank', title: 'Insert Blank Page', category: 'Document', shortcut: '', action: () => insertBlankPage() },
  { id: 'toggle_split', title: 'Toggle Split View (Dual Pane)', category: 'View', shortcut: '', action: () => toggleSplitView() },
  { id: 'toggle_sidebar', title: 'Toggle Right Sidebar Panel', category: 'View', shortcut: 'Ctrl+B', action: () => toggleSidebar() },
  { id: 'tool_pen', title: 'Switch Tool: Pen', category: 'Tools', shortcut: 'P', action: () => setTool('pen') },
  { id: 'tool_highlighter', title: 'Switch Tool: Highlighter', category: 'Tools', shortcut: 'H', action: () => setTool('highlighter') },
  { id: 'tool_eraser', title: 'Switch Tool: Eraser', category: 'Tools', shortcut: 'E', action: () => setTool('eraser') },
  { id: 'tool_lasso', title: 'Switch Tool: Lasso Erase', category: 'Tools', shortcut: 'V', action: () => setTool('lasso') },
  { id: 'tool_ruler', title: 'Switch Tool: Ruler Line', category: 'Tools', shortcut: 'R', action: () => setTool('ruler') },
  { id: 'tool_rect', title: 'Switch Tool: Rectangle', category: 'Tools', shortcut: 'Q', action: () => setTool('rect') },
  { id: 'tool_ellipse', title: 'Switch Tool: Ellipse', category: 'Tools', shortcut: 'O', action: () => setTool('ellipse') },
  { id: 'tool_laser', title: 'Switch Tool: Laser Pointer', category: 'Tools', shortcut: 'L', action: () => setTool('laser') },
  { id: 'undo', title: 'Undo', category: 'Edit', shortcut: 'Ctrl+Z', action: () => undo() },
  { id: 'redo', title: 'Redo', category: 'Edit', shortcut: 'Ctrl+Y', action: () => redo() },
  { id: 'next_page', title: 'Next Page', category: 'Navigation', shortcut: 'Right', action: () => goToPage(state.currentSheet + 1) },
  { id: 'prev_page', title: 'Previous Page', category: 'Navigation', shortcut: 'Left', action: () => goToPage(state.currentSheet - 1) },
];

let selectedCmdIndex = 0;
let currentMatches = [];

function openCommandPalette() {
  const modal = $('cmdPaletteModal');
  const input = $('cmdPaletteInput');
  modal.classList.remove('hidden');
  input.value = '';
  input.focus();
  renderCommandResults('');
}

function closeCommandPalette() {
  $('cmdPaletteModal').classList.add('hidden');
}

function renderCommandResults(query) {
  const container = $('cmdPaletteResults');
  const q = query.toLowerCase().trim();
  currentMatches = COMMANDS.filter(c => c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
  selectedCmdIndex = 0;
  container.innerHTML = currentMatches.map((c, i) => `
    <div class="cmd-item ${i === 0 ? 'selected' : ''}" data-index="${i}">
      <span>[${c.category}] ${c.title}</span>
      <span class="cmd-shortcut">${c.shortcut}</span>
    </div>
  `).join('');
  container.querySelectorAll('.cmd-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      currentMatches[i].action();
      closeCommandPalette();
    });
  });
}

function updatePaletteSelection() {
  const items = document.querySelectorAll('.cmd-item');
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === selectedCmdIndex);
  });
}

// ---- Radial Menu ----
function showRadialMenu(x, y) {
  const menu = $('radialMenu');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
}

function hideRadialMenu() {
  $('radialMenu').classList.add('hidden');
}

// ---- UI binding ----
function bindUI() {
  $('btnPen').addEventListener('click', () => setTool('pen'));
  $('btnHighlighter').addEventListener('click', () => setTool('highlighter'));
  $('btnEraser').addEventListener('click', () => setTool('eraser'));
  $('btnLasso') && $('btnLasso').addEventListener('click', () => setTool('lasso'));
  $('btnRuler') && $('btnRuler').addEventListener('click', () => setTool('ruler'));
  $('btnRect') && $('btnRect').addEventListener('click', () => setTool('rect'));
  $('btnEllipse') && $('btnEllipse').addEventListener('click', () => setTool('ellipse'));
  $('btnLaser') && $('btnLaser').addEventListener('click', () => setTool('laser'));

  $('colorPicker').addEventListener('input', e => {
    const h = e.target.value;
    state.color = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255);
  });

  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);

  $('btnSplit') && $('btnSplit').addEventListener('click', toggleSplitView);
  $('btnToggleSidebar') && $('btnToggleSidebar').addEventListener('click', toggleSidebar);
  $('btnCollapseSidebar') && $('btnCollapseSidebar').addEventListener('click', toggleSidebar);
  $('btnExpandSidebar') && $('btnExpandSidebar').addEventListener('click', toggleSidebar);
  $('btnCmdPalette') && $('btnCmdPalette').addEventListener('click', openCommandPalette);
  $('btnAddPage') && $('btnAddPage').addEventListener('click', insertBlankPage);
  $('btnInsertBlank') && $('btnInsertBlank').addEventListener('click', insertBlankPage);

  // Property popover binding
  $('btnProp') && $('btnProp').addEventListener('click', () => {
    const pop = $('propPopover');
    pop.classList.toggle('hidden');
  });

  $('widthSlider') && $('widthSlider').addEventListener('input', e => {
    state.baseWidth = parseFloat(e.target.value);
    $('widthVal').textContent = state.baseWidth + ' pt';
  });

  document.querySelectorAll('.swatch').forEach(s => {
    s.addEventListener('click', e => {
      const hex = e.target.getAttribute('data-color');
      state.color = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255);
      $('colorPicker').value = hex;
    });
  });

  $('btnPrev') && $('btnPrev').addEventListener('click', () => goToPage(state.currentSheet - 1));
  $('btnNext') && $('btnNext').addEventListener('click', () => goToPage(state.currentSheet + 1));

  $('btnOpen').addEventListener('click', async () => {
    if (window.__TAURI__) {
      try {
        const invoke = (window.__TAURI__.core && window.__TAURI__.core.invoke) || window.__TAURI__.invoke;
        let selectedPath = null;
        if (window.__TAURI_PLUGIN_DIALOG__ && window.__TAURI_PLUGIN_DIALOG__.open) {
          const res = await window.__TAURI_PLUGIN_DIALOG__.open({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          selectedPath = typeof res === 'string' ? res : (res && res.path);
        } else if (invoke) {
          const res = await invoke('plugin:dialog|open', {
            multiple: false,
            directory: false,
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
          });
          selectedPath = typeof res === 'string' ? res : (res && res.path);
        }

        if (selectedPath) {
          const infos = await invoke('open_pdf', { pathStr: selectedPath });
          state.pageInfos = infos;
          state.strokes = [];
          state.selectedStrokes = [];
          state.undoStack = [];
          state.redoStack = [];
          tileCache.clear();
          goToPage(0);
          $('docInfo').innerHTML = `
            <div>Loaded: ${selectedPath.split('\\').pop().split('/').pop()}</div>
            <div>Pages: ${infos.length}</div>
          `;
          return;
        }
      } catch (err) {
        console.warn('Tauri dialog failed, using file picker input fallback:', err);
      }
    }
    $('pdfFileInput') && $('pdfFileInput').click();
  });

  $('pdfFileInput') && $('pdfFileInput').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
                     (window.__TAURI__ && window.__TAURI__.invoke);
      if (file.path && invoke) {
        const infos = await invoke('open_pdf', { pathStr: file.path });
        state.pageInfos = infos;
        state.strokes = [];
        state.selectedStrokes = [];
        state.undoStack = [];
        state.redoStack = [];
        tileCache.clear();
        goToPage(0);
        $('docInfo').innerHTML = `
          <div>Loaded: ${file.name}</div>
          <div>Pages: ${infos.length}</div>
        `;
        return;
      }

      const arrayBuf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(arrayBuf));
      if (invoke) {
        const infos = await invoke('open_pdf_bytes', { name: file.name, bytes });
        state.pageInfos = infos;
        state.strokes = [];
        state.selectedStrokes = [];
        state.undoStack = [];
        state.redoStack = [];
        tileCache.clear();
        goToPage(0);
        $('docInfo').innerHTML = `
          <div>Loaded: ${file.name}</div>
          <div>Pages: ${infos.length}</div>
        `;
        return;
      }
    } catch (err) {
      console.warn('pdfFileInput error:', err);
      alert('Failed to open PDF: ' + err);
    }
  });

  $('btnSave').addEventListener('click', async () => {
    if (window.__TAURI__) {
      try {
        const savedPath = await window.__TAURI__.core.invoke('save_pdf', { outPathStr: null });
        alert('Saved to: ' + savedPath);
      } catch (err) { alert('Failed to save PDF: ' + err); }
    } else {
      alert('Running in browser mode. Save via Tauri host.');
    }
  });

  // Command palette events
  $('cmdPaletteInput') && $('cmdPaletteInput').addEventListener('input', e => {
    renderCommandResults(e.target.value);
  });

  $('cmdPaletteModal') && $('cmdPaletteModal').addEventListener('click', e => {
    if (e.target === $('cmdPaletteModal')) closeCommandPalette();
  });

  // Radial menu item events
  document.querySelectorAll('.radial-item').forEach(item => {
    item.addEventListener('click', e => {
      e.stopPropagation();
      const tool = item.getAttribute('data-tool');
      const action = item.getAttribute('data-action');
      if (tool) setTool(tool);
      else if (action === 'undo') undo();
      else if (action === 'palette') openCommandPalette();
      hideRadialMenu();
    });
  });

  window.addEventListener('click', e => {
    if (!e.target.closest('#radialMenu')) hideRadialMenu();
    if (!e.target.closest('#propPopover') && !e.target.closest('#btnProp')) {
      $('propPopover') && $('propPopover').classList.add('hidden');
    }
  });

  // Keyboard shortcuts
  const SPRING_MAP = { e: 'eraser', l: 'laser' };
  const TOOL_MAP = { p: 'pen', h: 'highlighter', r: 'ruler', q: 'rect', o: 'ellipse', v: 'lasso' };

  window.addEventListener('keydown', e => {
    if (!$('cmdPaletteModal').classList.contains('hidden')) {
      if (e.key === 'Escape') { closeCommandPalette(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentMatches.length) selectedCmdIndex = (selectedCmdIndex + 1) % currentMatches.length;
        updatePaletteSelection();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentMatches.length) selectedCmdIndex = (selectedCmdIndex - 1 + currentMatches.length) % currentMatches.length;
        updatePaletteSelection();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (currentMatches[selectedCmdIndex]) {
          currentMatches[selectedCmdIndex].action();
          closeCommandPalette();
        }
        return;
      }
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedStrokes && state.selectedStrokes.length) {
        e.preventDefault();
        const deleted = [];
        for (const s of state.selectedStrokes) {
          if (!s.deleted) {
            s.deleted = true;
            deleted.push(s);
          }
        }
        state.selectedStrokes = [];
        if (deleted.length) {
          state.undoStack.push({ type: 'erase', strokes: deleted });
          state.redoStack = [];
          redrawAll();
          clearWet();
        }
        return;
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openCommandPalette();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') { e.preventDefault(); undo(); return; }
      if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) { e.preventDefault(); redo(); return; }
      if (e.key === 's') { e.preventDefault(); $('btnSave').click(); return; }
      if (e.key === 'o') { e.preventDefault(); $('btnOpen').click(); return; }
      if (e.key === 'b') { e.preventDefault(); toggleSidebar(); return; }
      return;
    }

    if (e.altKey) return;
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (SPRING_MAP[k] && !state.springKey) {
      state.springKey = k;
      state.prevTool = state.activeTool;
      setTool(SPRING_MAP[k]);
    } else if (TOOL_MAP[k]) {
      setTool(TOOL_MAP[k]);
    }
  });

  window.addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    if (state.springKey === k) {
      state.springKey = null;
      setTool(state.prevTool);
    }
  });
}

function attachPointerHandlers() {
  wetCanvas.addEventListener('pointerdown', onDown);
  const moveEvt = ('onpointerrawupdate' in window) ? 'pointerrawupdate' : 'pointermove';
  wetCanvas.addEventListener(moveEvt, onMove);
  wetCanvas.addEventListener('pointerup', e => {
    onUp(e);
    if (state.strokes.length) checkOutOfBounds(state.strokes[state.strokes.length - 1]);
  });
  wetCanvas.addEventListener('pointercancel', e => {
    clearLaser();
    state.isErasing = false;
    state.cur = null;
    state.streamline = null;
    clearWet();
    $('toolbar').classList.remove('pen-down');
  });
  wetCanvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    showRadialMenu(e.clientX, e.clientY);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  tilesCanvas = $('tiles');
  dryCanvas = $('dry');
  wetCanvas = $('wet');

  viewport = new ViewportManager(() => {
    drawPageBackground();
    redrawTiles();
    redrawAll();
  });
  viewport.attachListeners($('stage'));

  resize();
  attachPointerHandlers();
  bindUI();
  updatePageUI();

  window.addEventListener('resize', resize);
});
