/* ============================================================================
 * app.js — Inkwell production web app controller
 * ========================================================================== */

const $ = id => document.getElementById(id);

function getInvoke() {
  if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
    return window.__TAURI__.core.invoke;
  }
  if (window.__TAURI__ && window.__TAURI__.invoke) {
    return window.__TAURI__.invoke;
  }
  if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
    return window.__TAURI_INTERNALS__.invoke;
  }
  return null;
}

function showToast(message, type = 'info') {
  let container = $('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => {
      toast.remove();
    });
  }, 3000);
}

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
  laserPoints: [],
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
let stageRect = null;

function updateStageRect() {
  if (wetCanvas) {
    stageRect = wetCanvas.getBoundingClientRect();
  } else {
    const host = $('stage');
    if (host) stageRect = host.getBoundingClientRect();
  }
  if (viewport && viewport.updateStageRect) {
    viewport.updateStageRect();
  }
}

const tileCache = new Map();
const tilesPending = new Map();
// Tracks the last tile render error message (null = no error).
let tileRenderError = null;

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
  const r = stageRect || (wetCanvas ? wetCanvas.getBoundingClientRect() : { left: 0, width: window.innerWidth });
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

const TILE_PT = 512;
const TILE_CACHE_MAX = 200;

function evictTileCache() {
  if (tileCache.size <= TILE_CACHE_MAX) return;
  let count = tileCache.size - TILE_CACHE_MAX;
  for (const [key, val] of tileCache.entries()) {
    if (count-- <= 0) break;
    if (val && val._bitmap && val._bitmap.close) {
      val._bitmap.close();
    } else if (val && val.close) {
      val.close();
    }
    tileCache.delete(key);
  }
}

function tileGridForRect(rx0, ry0, rx1, ry1) {
  const tiles = [];
  const tx0 = Math.floor(rx0 / TILE_PT);
  const ty0 = Math.floor(ry0 / TILE_PT);
  const tx1 = Math.ceil(rx1 / TILE_PT);
  const ty1 = Math.ceil(ry1 / TILE_PT);
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      tiles.push({
        tx, ty,
        rect: [tx * TILE_PT, ty * TILE_PT, (tx + 1) * TILE_PT, (ty + 1) * TILE_PT]
      });
    }
  }
  return tiles;
}

async function fetchTile(page, rect, px) {
  const invoke = getInvoke();
  if (!invoke) return null;
  const key = `${page}:${rect.join(',')}:${px}`;
  if (tileCache.has(key)) return { key, data: tileCache.get(key) };
  if (tilesPending.has(key)) return tilesPending.get(key);

  const task = (async () => {
    try {
      const raw = await invoke('render_tile', { page, rect, px });
      const rw = rect[2] - rect[0];
      const rh = rect[3] - rect[1];
      const scale = px / Math.max(rw, rh);
      const tileW = Math.round(rw * scale) || 1;
      const tileH = Math.round(rh * scale) || 1;
      const expectedBytes = tileW * tileH * 4;
      if (!raw || raw.length !== expectedBytes) {
        throw new Error(`Invalid tile buffer: expected ${expectedBytes} RGBA bytes (${tileW}x${tileH}), got ${raw ? raw.length : 0}`);
      }
      const rgbaArray = new Uint8ClampedArray(raw.buffer || raw, raw.byteOffset || 0, raw.byteLength || raw.length);
      const imgData = new ImageData(rgbaArray, tileW, tileH);
      tileCache.set(key, imgData);
      tileRenderError = null;
      return { key, data: imgData };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error('[inkwell] render_tile error:', msg);
      tileRenderError = msg;
      scheduleRedrawTiles();
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

function drawSplitDivider() {
  if (!viewport || !viewport.splitMode) return;
  const w = tilesCanvas.width / state.dpr;
  const h = tilesCanvas.height / state.dpr;
  const cx = w / 2;
  tctx.save();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.scale(state.dpr, state.dpr);
  tctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  tctx.lineWidth = 2;
  tctx.beginPath();
  tctx.moveTo(cx, 0);
  tctx.lineTo(cx, h);
  tctx.stroke();
  tctx.restore();
}

function drawZoomIndicator() {
  if (!viewport) return;
  const activeZoom = viewport.splitMode && viewport.activePane === 'right' ? viewport.rightZoom : viewport.zoom;
  if ($('zoomLevelDisplay')) {
    $('zoomLevelDisplay').textContent = Math.round(activeZoom * 100) + '%';
  }
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
    tctx.fillStyle = 'rgba(255,255,255,0.45)';
    tctx.fillText(pct, bounds.x + bounds.width - 12, bounds.y + bounds.height - 8);
  }
  tctx.restore();
}

let redrawPending = false;
function scheduleRedrawTiles() {
  if (redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => {
    redrawPending = false;
    redrawTiles();
  });
}

async function redrawTiles() {
  const drawEpoch = ++redrawTiles.epoch;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, tilesCanvas.width, tilesCanvas.height);

  for (const pane of visiblePanes()) drawPageBackground(pane);

  if (state.pageInfos.length) {
    await Promise.all(visiblePanes().map(pane => {
      const sheetIdx = paneSheet(pane);
      const pi = state.pageInfos[sheetIdx];
      return pi ? redrawTilesForPane(pane, pi, sheetIdx, drawEpoch) : Promise.resolve();
    }));
  }

  drawSplitDivider();
  drawZoomIndicator();
  evictTileCache();
}
redrawTiles.epoch = 0;

function quantizeTilePx(zoom, dpr) {
  const targetPx = TILE_PT * zoom * dpr;
  if (targetPx <= 384) return 256;
  if (targetPx <= 640) return 512;
  if (targetPx <= 896) return 768;
  if (targetPx <= 1280) return 1024;
  if (targetPx <= 1792) return 1536;
  return 2048;
}

function findCachedTileFallback(sheetIdx, tr) {
  const lodSteps = [512, 768, 256, 1024, 1536, 2048];
  for (const altPx of lodSteps) {
    const altKey = `${sheetIdx}:${tr.join(',')}:${altPx}`;
    if (tileCache.has(altKey)) {
      return tileCache.get(altKey);
    }
  }
  return null;
}

async function drawTileData(data, tr, pane, pi) {
  if (!data) return;
  const [sx0, sy0] = viewport.worldToScreen(tr[0], tr[1], pane);
  const [sx1, sy1] = viewport.worldToScreen(tr[2], tr[3], pane);
  const [pageX0, pageY0] = viewport.worldToScreen(0, 0, pane);
  const [pageX1, pageY1] = viewport.worldToScreen(pi.width_pt, pi.height_pt, pane);

  tctx.save();
  tctx.scale(state.dpr, state.dpr);
  clipToPane(tctx, pane);
  tctx.beginPath();
  tctx.rect(pageX0, pageY0, pageX1 - pageX0, pageY1 - pageY0);
  tctx.clip();

  let drawSource = data;
  if (drawSource instanceof ImageData) {
    if (!drawSource._bitmap) {
      drawSource._bitmap = await createImageBitmap(drawSource);
    }
    drawSource = drawSource._bitmap;
  }
  tctx.drawImage(drawSource, sx0, sy0, sx1 - sx0, sy1 - sy0);
  tctx.restore();
}

async function redrawTilesForPane(pane, pi, sheetIdx, drawEpoch) {
  const bounds = paneBounds(pane);

  const [wx0, wy0] = viewport.screenToWorld(bounds.x, bounds.y, pane);
  const [wx1, wy1] = viewport.screenToWorld(bounds.x + bounds.width, bounds.y + bounds.height, pane);
  const rx0 = Math.max(0, wx0), ry0 = Math.max(0, wy0);
  const rx1 = Math.min(pi.width_pt, wx1), ry1 = Math.min(pi.height_pt, wy1);
  if (rx1 <= rx0 || ry1 <= ry0) return;

  const zoom = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
  const gridTiles = tileGridForRect(rx0, ry0, rx1, ry1);
  const px = quantizeTilePx(zoom, state.dpr);

  const promises = gridTiles.map(async gt => {
    const tr = [
      Math.max(0, gt.rect[0]),
      Math.max(0, gt.rect[1]),
      Math.min(pi.width_pt, gt.rect[2]),
      Math.min(pi.height_pt, gt.rect[3])
    ];
    if (tr[2] <= tr[0] || tr[3] <= tr[1]) return;

    const trKey = `${sheetIdx}:${tr.join(',')}:${px}`;
    if (tileCache.has(trKey)) {
      await drawTileData(tileCache.get(trKey), tr, pane, pi);
      return;
    }

    // Blit fallback cached tile immediately to prevent flicker during LOD fetch
    const fallback = findCachedTileFallback(sheetIdx, tr);
    if (fallback) {
      await drawTileData(fallback, tr, pane, pi);
    }

    const result = await fetchTile(sheetIdx, tr, px);
    if (!result || drawEpoch !== redrawTiles.epoch) return;

    await drawTileData(result.data, tr, pane, pi);
  });

  await Promise.all(promises);

  if (tileRenderError && drawEpoch === redrawTiles.epoch && tileCache.size === 0) {
    const [pageX0, pageY0] = viewport.worldToScreen(0, 0, pane);
    const [pageX1, pageY1] = viewport.worldToScreen(pi.width_pt, pi.height_pt, pane);
    const pw = pageX1 - pageX0, ph = pageY1 - pageY0;
    tctx.save();
    tctx.scale(state.dpr, state.dpr);
    clipToPane(tctx, pane);
    tctx.fillStyle = 'rgba(239,68,68,0.10)';
    tctx.fillRect(pageX0, pageY0, pw, ph);
    tctx.fillStyle = '#ef4444';
    tctx.font = `bold ${Math.min(24, pw * 0.06)}px system-ui, sans-serif`;
    tctx.textAlign = 'center';
    tctx.textBaseline = 'middle';
    const cx = pageX0 + pw / 2, cy = pageY0 + ph / 2;
    tctx.fillText('⚠ PDF render failed', cx, cy - 18);
    tctx.font = `${Math.min(13, pw * 0.032)}px system-ui, sans-serif`;
    tctx.fillStyle = '#b91c1c';
    const errText = tileRenderError.length > 80
      ? tileRenderError.slice(0, 77) + '…'
      : tileRenderError;
    tctx.fillText(errText, cx, cy + 12);
    tctx.restore();
  }
}


function makeCtx(canvas) {
  return canvas.getContext('2d', { desynchronized: true, alpha: true });
}

function resize() {
  updateStageRect();
  const r = stageRect;
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
  scheduleRedrawTiles();
  redrawAll();
}

let redrawAllPending = false;
function scheduleRedrawAll() {
  if (redrawAllPending) return;
  redrawAllPending = true;
  requestAnimationFrame(() => {
    redrawAllPending = false;
    redrawAll();
  });
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
  const r = stageRect || (wetCanvas ? wetCanvas.getBoundingClientRect() : { left: 0, top: 0 });
  return viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top, pane);
}

// ---- Page navigation & pre-fetching ----
function prefetchAdjacentPages() {
  if (!state.pageInfos.length) return;
  const curr = state.leftSheet;
  const total = state.pageInfos.length;
  const adjacentSheets = [curr - 1, curr + 1].filter(s => s >= 0 && s < total);

  for (const sheetIdx of adjacentSheets) {
    const pi = state.pageInfos[sheetIdx];
    if (!pi) continue;
    const tr = [0, 0, pi.width_pt, pi.height_pt];
    fetchTile(sheetIdx, tr, 512).catch(() => {});
  }
}

function goToPage(i, pane = 'left') {
  if (i < 0 || i >= state.pageInfos.length) return;
  if (pane === 'right' && viewport.splitMode) {
    state.rightSheet = i;
  } else {
    state.leftSheet = i;
  }
  const pi = state.pageInfos[i];
  recenterPanesOnly(pi);
  updatePageUI();
  scheduleRedrawTiles();
  redrawAll();
  prefetchAdjacentPages();
}

function fitPageInPanes(pi = state.pageInfos[state.leftSheet]) {
  if (!pi) return;
  const left = paneBounds('left');
  const piLeft = state.pageInfos[state.leftSheet] || pi;
  viewport.fitPage(piLeft.width_pt, piLeft.height_pt, 'left');

  if (viewport.splitMode) {
    const piRight = state.pageInfos[state.rightSheet] || pi;
    viewport.fitPage(piRight.width_pt, piRight.height_pt, 'right');
  }
}

function recenterPanesOnly(pi = state.pageInfos[state.leftSheet]) {
  if (!pi) return;
  const left = paneBounds('left');
  const piLeft = state.pageInfos[state.leftSheet] || pi;
  viewport.panX = Math.round(left.x + (left.width - piLeft.width_pt * viewport.zoom) / 2);
  viewport.panY = Math.max(20, Math.round(left.y + (left.height - piLeft.height_pt * viewport.zoom) / 2));

  if (viewport.splitMode) {
    const right = paneBounds('right');
    const piRight = state.pageInfos[state.rightSheet] || pi;
    viewport.rightPanX = Math.round(right.x + (right.width - piRight.width_pt * viewport.rightZoom) / 2);
    viewport.rightPanY = Math.max(20, Math.round(right.y + (right.height - piRight.height_pt * viewport.rightZoom) / 2));
  }
}

function centerPageInPanes(pi = state.pageInfos[state.leftSheet]) {
  fitPageInPanes(pi);
}

function updatePageUI() {
  const total = state.pageInfos.length;
  if (!total) {
    $('pageNum').textContent = '—';
    $('btnPrev').disabled = true;
    $('btnNext').disabled = true;
    $('splitPageNav') && $('splitPageNav').classList.add('hidden');
    $('leftNavLabel') && $('leftNavLabel').classList.add('hidden');
    return;
  }

  const isSplit = viewport.splitMode;
  $('leftNavLabel') && $('leftNavLabel').classList.toggle('hidden', !isSplit);
  $('splitPageNav') && $('splitPageNav').classList.toggle('hidden', !isSplit);

  const leftCur = state.leftSheet + 1;
  $('pageNum').textContent = isSplit ? `${leftCur}` : `${leftCur} / ${total}`;
  $('btnPrev').disabled = state.leftSheet <= 0;
  $('btnNext').disabled = state.leftSheet >= total - 1;

  if (isSplit) {
    const rightCur = state.rightSheet + 1;
    $('rightPageNum') && ($('rightPageNum').textContent = `${rightCur}`);
    $('btnRightPrev') && ($('btnRightPrev').disabled = state.rightSheet <= 0);
    $('btnRightNext') && ($('btnRightNext').disabled = state.rightSheet >= total - 1);
  }
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
    const invoke = getInvoke();
    if (invoke) {
      invoke('erase_strokes_near', {
        sheet: targetSheet,
        px: wx,
        py: wy,
        radius: radius,
      }).catch(err => console.warn('erase IPC failed:', err));
    }
  }
}

// ---- consume (wet layer drawing) ----
function consume(e) {
  if (state.activeTool === 'laser') {
    const [wx, wy] = localXY(e, state.drawingPane);
    state.laserPos = [wx, wy];
    addLaserPoint(wx, wy);
    return;
  }
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
let laserAnimId = null;

function addLaserPoint(x, y) {
  if (!state.laserPoints) state.laserPoints = [];
  state.laserPoints.push({ x, y, t: Date.now() });
  startLaserAnimation();
}

function startLaserAnimation() {
  if (!laserAnimId) {
    laserAnimId = requestAnimationFrame(updateLaserAnimation);
  }
}

function updateLaserAnimation() {
  laserAnimId = null;
  const now = Date.now();
  if (!state.laserPoints) state.laserPoints = [];

  state.laserPoints = state.laserPoints.filter(p => now - p.t < 1200);

  clearWet();
  if (state.laserPoints.length > 0) {
    drawLaser();
    laserAnimId = requestAnimationFrame(updateLaserAnimation);
  }
}

function drawLaser() {
  const now = Date.now();
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.scale(state.dpr, state.dpr);
  clipToPane(wctx, state.drawingPane);

  if (state.laserPoints && state.laserPoints.length > 0) {
    for (let i = 0; i < state.laserPoints.length; i++) {
      const pt = state.laserPoints[i];
      const age = now - pt.t;
      if (age >= 1200) continue;
      const alpha = Math.max(0, 1 - age / 1200);
      const [sx, sy] = viewport.worldToScreen(pt.x, pt.y, state.drawingPane);

      wctx.beginPath();
      wctx.arc(sx, sy, 8, 0, Math.PI * 2);
      wctx.fillStyle = `rgba(239,68,68,${(0.15 * alpha).toFixed(3)})`;
      wctx.fill();

      wctx.beginPath();
      wctx.arc(sx, sy, 4, 0, Math.PI * 2);
      wctx.fillStyle = `rgba(239,68,68,${(0.9 * alpha).toFixed(3)})`;
      wctx.fill();
    }
  } else if (state.laserPos) {
    const [sx, sy] = viewport.worldToScreen(state.laserPos[0], state.laserPos[1], state.drawingPane);
    wctx.beginPath();
    wctx.arc(sx, sy, 8, 0, Math.PI * 2);
    wctx.fillStyle = 'rgba(239,68,68,0.15)';
    wctx.fill();

    wctx.beginPath();
    wctx.arc(sx, sy, 4, 0, Math.PI * 2);
    wctx.fillStyle = 'rgba(239,68,68,0.9)';
    wctx.fill();
  }

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
  const invoke = getInvoke();
  if (invoke) {
    const payload = samples.map(([x, y], i) => ({ x, y, pressure: 0.7, t_ms: i * 10 }));
    invoke('commit_stroke', {
      sheet: state.currentSheet, tool: 'pen', rgb: state.color,
      baseWidth: state.baseWidth, samples: payload,
    }).catch(err => console.warn('shape commit_stroke failed:', err));
  }
}

// ---- Pointer handlers ----
// ---- Pointer handlers ----
function onDown(e) {
  if (e.button !== 0 && e.pointerType !== 'pen') return;
  try { wetCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  $('toolbar') && $('toolbar').classList.add('pen-down');
  $('pageNav') && $('pageNav').classList.add('pen-down');
  $('zoomControl') && $('zoomControl').classList.add('pen-down');

  state.drawingPane = paneForEvent(e);
  viewport.activePane = state.drawingPane;

  if (state.spacePanActive || state.activeTool === 'pan') {
    viewport.isPanning = true;
    viewport.lastPanPt = [e.clientX, e.clientY];
    if (wetCanvas) wetCanvas.classList.add('panning');
    return;
  }

  const [wx, wy] = localXY(e, state.drawingPane);

  if (state.activeTool === 'laser') {
    state.laserPos = [wx, wy];
    addLaserPoint(wx, wy);
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
  if (viewport.isPanning) {
    const dx = e.clientX - viewport.lastPanPt[0];
    const dy = e.clientY - viewport.lastPanPt[1];
    viewport.lastPanPt = [e.clientX, e.clientY];
    const pane = state.drawingPane || paneForEvent(e);
    const curPanX = pane === 'right' ? viewport.rightPanX : viewport.panX;
    const curPanY = pane === 'right' ? viewport.rightPanY : viewport.panY;
    viewport.setPan(curPanX + dx, curPanY + dy, pane);
    scheduleRedrawTiles();
    redrawAll();
    return;
  }

  const [wx, wy] = localXY(e, state.drawingPane);

  if (state.activeTool === 'laser') {
    state.laserPos = [wx, wy];
    if (e.getCoalescedEvents) {
      const co = e.getCoalescedEvents();
      (co.length ? co : [e]).forEach(c => consume(c));
    } else {
      addLaserPoint(wx, wy);
    }
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
      const dx = wx - state.shapeStart[0], dy = wy - state.shapeStart[1];
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      ex = state.shapeStart[0] + Math.cos(angle) * len;
      ey = state.shapeStart[1] + Math.sin(angle) * len;
    } else if (e.shiftKey) {
      const dx = Math.abs(wx - state.shapeStart[0]);
      const dy = Math.abs(wy - state.shapeStart[1]);
      const s = Math.max(dx, dy);
      ex = state.shapeStart[0] + Math.sign(wx - state.shapeStart[0]) * s;
      ey = state.shapeStart[1] + Math.sign(wy - state.shapeStart[1]) * s;
    }
    state.shapeEnd = [ex, ey];
    clearWet();
    if (state.shapeKind === 'line') {
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
  $('toolbar') && $('toolbar').classList.remove('pen-down');
  $('pageNav') && $('pageNav').classList.remove('pen-down');
  $('zoomControl') && $('zoomControl').classList.remove('pen-down');

  if (viewport.isPanning) {
    viewport.isPanning = false;
    if (wetCanvas) wetCanvas.classList.remove('panning');
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }

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
        const stroke = { ...rulerStroke, sheet: state.currentSheet, deleted: false };
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
        const invoke = getInvoke();
        if (invoke) {
          invoke('commit_stroke', {
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
  if (typeof Ink.getPath2D === 'function') {
    finishedStroke._cachedPath2D = Ink.getPath2D(finishedStroke);
  }
  const strokeRec = {
    id: finishedStroke.id, kind: finishedStroke.kind, rgb: finishedStroke.rgb,
    base_width: finishedStroke.base_width, points: finishedStroke.points.slice(),
    sheet: state.currentSheet, deleted: false,
    _cachedPath2D: finishedStroke._cachedPath2D || null,
  };
  state.strokes.push(strokeRec);
  state.undoStack.push({ type: 'add', stroke: strokeRec });
  state.redoStack = [];

  const invoke = getInvoke();
  if (invoke) {
    try {
      const samplesPayload = finishedStroke.points.map(pt => ({
        x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
      }));
      await invoke('commit_stroke', {
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
  state.laserPoints = [];
  if (laserAnimId) {
    cancelAnimationFrame(laserAnimId);
    laserAnimId = null;
  }
  clearWet();
}

function updateStats(pointerType) {
  $('inputStats').innerHTML = `
    <div>Pointer: ${pointerType || 'pen'}</div>
    <div>Samples: ${state.samplesCount}</div>
    <div>Strokes: ${state.strokes.filter(s => !s.deleted).length}</div>
  `;// ---- Tool selection ----
const TOOL_BTNS = ['btnPen', 'btnHighlighter', 'btnEraser', 'btnPan', 'btnLasso',
                   'btnRuler', 'btnRect', 'btnEllipse', 'btnLaser'];
function setTool(tool) {
  if (state.activeTool === 'laser' && tool !== 'laser') {
    clearLaser();
  }
  state.activeTool = tool;
  TOOL_BTNS.forEach(id => $(id) && $(id).classList.remove('active'));
  const toolBtnMap = {
    pen: 'btnPen', highlighter: 'btnHighlighter', eraser: 'btnEraser', pan: 'btnPan',
    lasso: 'btnLasso', ruler: 'btnRuler', rect: 'btnRect',
    ellipse: 'btnEllipse', laser: 'btnLaser',
  };
  const btnId = toolBtnMap[tool];
  if (btnId) $(btnId) && $(btnId).classList.add('active');
  if (wetCanvas) {
    wetCanvas.className = `tool-${tool}`;
  }
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
    state.redoStack.push(op);
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
  const invoke = getInvoke();
  if (invoke) {
    try {
      const pageInfo = await invoke('insert_blank_page', {
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
  scheduleRedrawTiles();
  redrawAll();
}

function toggleSidebar() {
  const sidebar = $('sidebar');
  if (!sidebar) return;
  const collapsed = sidebar.classList.toggle('collapsed');
  $('btnToggleSidebar') && $('btnToggleSidebar').classList.toggle('active', !collapsed);
  resize();
  viewport.updateStageRect();
  const pi = state.pageInfos[state.leftSheet];
  if (pi) recenterPanesOnly(pi);
  scheduleRedrawTiles();
  redrawAll();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

document.addEventListener('fullscreenchange', () => {
  const isFS = !!document.fullscreenElement;
  $('btnFullscreen') && $('btnFullscreen').classList.toggle('active', isFS);
  resize();
  viewport.updateStageRect();
  const pi = state.pageInfos[state.leftSheet];
  if (pi) recenterPanesOnly(pi);
  scheduleRedrawTiles();
  redrawAll();
});

// Spacebar Spring Panning
let spaceKeyDown = false;
let previousToolBeforeSpace = null;

window.addEventListener('keydown', e => {
  if (e.code === 'Space' && !spaceKeyDown) {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
      return;
    }
    e.preventDefault();
    spaceKeyDown = true;
    previousToolBeforeSpace = state.activeTool;
    state.spacePanActive = true;
    if (wetCanvas) wetCanvas.classList.add('space-pan');
  }
});

window.addEventListener('keyup', e => {
  if (e.code === 'Space' && spaceKeyDown) {
    e.preventDefault();
    spaceKeyDown = false;
    state.spacePanActive = false;
    if (wetCanvas) wetCanvas.classList.remove('space-pan');
    if (previousToolBeforeSpace) {
      setTool(previousToolBeforeSpace);
      previousToolBeforeSpace = null;
    }
  }
});

// ---- Command Palette ----
const COMMANDS = [
  { id: 'open_pdf', title: 'Open PDF Document', category: 'File', shortcut: 'Ctrl+O', action: () => $('btnOpen').click() },
  { id: 'save_pdf', title: 'Save PDF Document', category: 'File', shortcut: 'Ctrl+S', action: () => $('btnSave').click() },
  { id: 'insert_blank', title: 'Insert Blank Page', category: 'Document', shortcut: '', action: () => insertBlankPage() },
  { id: 'toggle_split', title: 'Toggle Split View (Dual Pane)', category: 'View', shortcut: '', action: () => toggleSplitView() },
  { id: 'toggle_sidebar', title: 'Toggle Right Sidebar Panel', category: 'View', shortcut: 'Ctrl+B', action: () => toggleSidebar() },
  { id: 'toggle_fullscreen', title: 'Toggle Fullscreen Mode', category: 'View', shortcut: 'F11', action: () => toggleFullscreen() },
  { id: 'tool_pen', title: 'Switch Tool: Pen', category: 'Tools', shortcut: 'P', action: () => setTool('pen') },
  { id: 'tool_highlighter', title: 'Switch Tool: Highlighter', category: 'Tools', shortcut: 'H', action: () => setTool('highlighter') },
  { id: 'tool_eraser', title: 'Switch Tool: Eraser', category: 'Tools', shortcut: 'E', action: () => setTool('eraser') },
  { id: 'tool_pan', title: 'Switch Tool: Pan / Hand', category: 'Tools', shortcut: 'Hold Space', action: () => setTool('pan') },
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
  $('btnPan') && $('btnPan').addEventListener('click', () => setTool('pan'));
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
    const pi = state.pageInfos[state.leftSheet];
    if (pi) {
      fitPageInPanes(pi);
      scheduleRedrawTiles();
      redrawAll();
    }
  });

  $('btnFullscreen') && $('btnFullscreen').addEventListener('click', toggleFullscreen);


  $('btnToggleSidebar') && $('btnToggleSidebar').addEventListener('click', toggleSidebar);
  $('btnCollapseSidebar') && $('btnCollapseSidebar').addEventListener('click', toggleSidebar);
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
      document.querySelectorAll('.swatch').forEach(sw => sw.classList.remove('active'));
      e.target.classList.add('active');
    });
  });

  $('btnPrev') && $('btnPrev').addEventListener('click', () => goToPage(state.leftSheet - 1, 'left'));
  $('btnNext') && $('btnNext').addEventListener('click', () => goToPage(state.leftSheet + 1, 'left'));

  $('btnRightPrev') && $('btnRightPrev').addEventListener('click', () => goToPage(state.rightSheet - 1, 'right'));
  $('btnRightNext') && $('btnRightNext').addEventListener('click', () => goToPage(state.rightSheet + 1, 'right'));

async function checkWalRecovery() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    const docInfo = await invoke('get_document_info');
    if (docInfo && docInfo.strokes > 0) {
      showToast("Restored unsaved strokes from crash journal", "info");
    }
  } catch (err) {
    // Ignore WAL info error
  }
}

  $('btnOpen').addEventListener('click', async () => {
    const invoke = getInvoke();
    if (invoke) {
      try {
        let selectedPath = null;
        if (window.__TAURI_PLUGIN_DIALOG__ && window.__TAURI_PLUGIN_DIALOG__.open) {
          const res = await window.__TAURI_PLUGIN_DIALOG__.open({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          selectedPath = typeof res === 'string' ? res : (res && res.path);
        } else {
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
          tileRenderError = null;
          goToPage(0);
          $('docInfo').innerHTML = `
            <div>Loaded: ${selectedPath.split('\\').pop().split('/').pop()}</div>
            <div>Pages: ${infos.length}</div>
          `;
          await checkWalRecovery();
          return;
        }
      } catch (err) {
        console.warn('[inkwell] Native dialog open failed, falling back to file picker:', err);
      }
    }
    $('pdfFileInput') && $('pdfFileInput').click();
  });

  $('pdfFileInput') && $('pdfFileInput').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const invoke = getInvoke();
      const filePath = file.path || file.webkitRelativePath;
      if (filePath && invoke) {
        const infos = await invoke('open_pdf', { pathStr: filePath });
        state.pageInfos = infos;
        state.strokes = [];
        state.selectedStrokes = [];
        state.undoStack = [];
        state.redoStack = [];
        tileCache.clear();
        tileRenderError = null;
        goToPage(0);
        $('docInfo').innerHTML = `
          <div>Loaded: ${file.name}</div>
          <div>Pages: ${infos.length}</div>
        `;
        await checkWalRecovery();
        return;
      }

      const arrayBuf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(arrayBuf));
      if (bytes.length > 5 * 1024 * 1024) {
        console.warn('[inkwell] Large PDF (>5 MB) sent via IPC bytes path — this may be slow or fail. Consider using file.path if available.');
      }
      if (invoke) {
        const infos = await invoke('open_pdf_bytes', { name: file.name, bytes });
        state.pageInfos = infos;
        state.strokes = [];
        state.selectedStrokes = [];
        state.undoStack = [];
        state.redoStack = [];
        tileCache.clear();
        tileRenderError = null;
        goToPage(0);
        $('docInfo').innerHTML = `
          <div>Loaded: ${file.name}</div>
          <div>Pages: ${infos.length}</div>
        `;
        await checkWalRecovery();
        return;
      }
      showToast('Tauri IPC is unavailable in this environment.', 'warning');
    } catch (err) {
      console.error('[inkwell] pdfFileInput error:', err);
      showToast('Failed to open PDF: ' + (err.message || err), 'error');
    }
  });

  $('btnSave').addEventListener('click', async () => {
    const invoke = getInvoke();
    if (invoke) {
      try {
        const savedPath = await invoke('save_pdf', { outPathStr: null });
        showToast('Saved to: ' + savedPath, 'success');
      } catch (err) { showToast('Failed to save PDF: ' + err, 'error'); }
    } else {
      showToast('Running in browser mode. Save via Tauri host.', 'info');
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
    scheduleRedrawTiles();
    scheduleRedrawAll();
  });
  viewport.attachListeners($('stage'));

  resize();
  attachPointerHandlers();
  bindUI();
  setTool(state.activeTool);
  updatePageUI();

  window.addEventListener('resize', resize);
  window.addEventListener('scroll', updateStageRect, { passive: true });
});
