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

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const state = {
  activeTool: 'pen',     // 'pen', 'highlighter', 'eraser', 'lasso', 'ruler',
                          // 'rect', 'ellipse', 'laser'
  prevTool: 'pen',        // restored after spring-loaded key release
  springKey: null,        // which key is spring-held right now
  color: [0.08, 0.09, 0.14],
  penColor: [0.08, 0.09, 0.14],
  highlighterColor: [0.99, 0.93, 0.28],
  textColor: '#141724',
  shapesColor: [0.08, 0.09, 0.14],
  penWidth: 1.6,
  highlighterWidth: 16.0,
  baseWidth: 1.6,         // Fine elegant line width matching Xournal++ / Excalidraw
  strokes: [],           // {id, kind, rgb, base_width, points[], deleted, sheet}
  selectedStrokes: [],
  images: [],            // [{id, sheet, x, y, width, height, dataUrl, _el, deleted}]
  selectedImages: [],
  textObjects: [],       // [{id, sheet, x, y, text, fontSize, color, bold, italic, width, height, deleted}]
  selectedTextObjects: [],
  pageTextSpans: {},     // { [sheet: number]: [{ text, rect: [x0, y0, x1, y1], page_index }] }
  selectedTextSpans: [],
  selectedTextString: '',
  isSelectingText: false,
  activeTextEditorObj: null,
  handDownPt: null,
  handStartWorldPt: null,
  clipboard: null,       // { type: 'inkwell_objects', strokes: [], images: [] }
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
  outline: [],           // hierarchical outline [{ title, page_index, children }]
  bookmarks: [],         // [{ id, page, label, createdAt }]
  inkVisible: true,
  shapeStart: null,
  shapeEnd: null,
  shapeKind: null,       // 'rect' | 'ellipse' | 'line'
  lassoPath: null,       // [[wx, wy], ...] for freeform lasso polygon
  transformMode: null,   // 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
  transformStartPt: null,
  transformInitialBounds: null,
  transformInitialStrokes: null,
  transformInitialImages: null,
  laserPos: null,
  laserTimer: null,
  laserPoints: [],
  streamline: null,
  drawingPane: 'left',
  navHistory: [],   // page navigation history (header Back/Forward)
  navIndex: -1,
  activeDrawer: null, // which drawer view is open: 'thumbnails' | 'outline' | ...
  isDirty: false,
  autosaveDelayMs: parseInt(localStorage.getItem('inkwell_autosave_delay') || '0', 10),
  autosaveTimer: null,
  isSaving: false,
};

function updateSaveStatusUI(status) {
  const badge = $('docStatusBadge');
  const text = $('docStatusText');
  if (!badge || !text) return;
  badge.classList.remove('dirty', 'saving');
  if (status === 'saving') {
    badge.classList.add('saving');
    text.textContent = 'Saving...';
  } else if (status === 'dirty') {
    badge.classList.add('dirty');
    text.textContent = state.autosaveDelayMs > 0 ? 'Autosaving...' : 'Unsaved';
  } else {
    text.textContent = 'Vector Ready';
  }
}

function markDirty() {
  state.isDirty = true;
  updateSaveStatusUI('dirty');
  triggerAutosaveDebounced();
  persistSessionState();
}

function triggerAutosaveDebounced() {
  if (state.autosaveDelayMs <= 0) return;
  if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(() => {
    state.autosaveTimer = null;
    performBackgroundAutosave();
  }, state.autosaveDelayMs);
}

async function performBackgroundAutosave() {
  if (!state.isDirty || state.isSaving) return;
  if (state.cur !== null || (viewport && viewport.isPanning)) {
    triggerAutosaveDebounced();
    return;
  }
  const curTab = state.tabs && state.tabs.find(t => t.id === state.activeTabId);
  if (!curTab || !curTab.pathStr) return;

  state.isSaving = true;
  updateSaveStatusUI('saving');
  try {
    await saveDocument(false, true);
    state.isDirty = false;
    updateSaveStatusUI('saved');
  } catch (err) {
    console.warn('[inkwell] Background autosave deferred:', err);
    updateSaveStatusUI('dirty');
  } finally {
    state.isSaving = false;
  }
}

function journalImageMutation(op, imgObj) {
  const invoke = getInvoke();
  if (!invoke || !imgObj) return;
  if (op === 'add' || op === 'upsert') {
    invoke('journal_image_mutation', {
      op: 'upsert',
      image: {
        id: String(imgObj.id),
        sheet: imgObj.sheet || 0,
        x: imgObj.x,
        y: imgObj.y,
        width: imgObj.width,
        height: imgObj.height,
        data_url: imgObj.dataUrl || '',
      },
      imageId: null,
    }).catch(e => console.warn('[inkwell] journal_image_mutation error:', e));
  } else if (op === 'delete' || op === 'remove') {
    invoke('journal_image_mutation', {
      op: 'delete',
      image: null,
      imageId: String(imgObj.id),
    }).catch(e => console.warn('[inkwell] journal_image_mutation error:', e));
  }
}

function journalTextMutation(op, textObj) {
  const invoke = getInvoke();
  if (!invoke || !textObj) return;
  if (op === 'add' || op === 'upsert') {
    invoke('journal_text_mutation', {
      op: 'upsert',
      text: {
        id: String(textObj.id),
        sheet: textObj.sheet || 0,
        x: textObj.x,
        y: textObj.y,
        text: textObj.text || '',
        font_size: textObj.fontSize || 16,
        color: textObj.color || '#141724',
        bold: !!textObj.bold,
        italic: !!textObj.italic,
        width: textObj.width || 120,
        height: textObj.height || 30,
      },
      textId: null,
    }).catch(e => console.warn('[inkwell] journal_text_mutation error:', e));
  } else if (op === 'delete' || op === 'remove') {
    invoke('journal_text_mutation', {
      op: 'delete',
      text: null,
      textId: String(textObj.id),
    }).catch(e => console.warn('[inkwell] journal_text_mutation error:', e));
  }
}

function persistSessionState() {
  try {
    if (!state.tabs || !state.tabs.length) return;
    const sessionData = {
      activeTabId: state.activeTabId,
      tabs: state.tabs.map(t => ({
        id: t.id,
        title: t.title,
        pathStr: t.pathStr,
        leftSheet: t.leftSheet || 0,
        rightSheet: t.rightSheet || 0,
      })),
    };
    localStorage.setItem('inkwell_open_tabs', JSON.stringify(sessionData));
  } catch (_) {}
}

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
  const r = stageRect || (wetCanvas ? (stageRect = wetCanvas.getBoundingClientRect()) : { left: 0, width: window.innerWidth });
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
    if (val && val._bitmap && typeof val._bitmap.close === 'function') {
      val._bitmap.close();
    } else if (val && typeof val.close === 'function') {
      val.close();
    }
    tileCache.delete(key);
  }
}

function clearTileCache() {
  for (const val of tileCache.values()) {
    if (val && val._bitmap && typeof val._bitmap.close === 'function') {
      val._bitmap.close();
    } else if (val && typeof val.close === 'function') {
      val.close();
    }
  }
  tileCache.clear();
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
      // The backend may deliver the RGBA buffer as a JS number array (default
      // JSON IPC) or as an ArrayBuffer / typed array (raw IPC). Normalise all
      // three forms before validating the exact byte count.
      let rgbaData = raw;
      if (rgbaData instanceof ArrayBuffer) {
        rgbaData = new Uint8ClampedArray(rgbaData);
      } else if (Array.isArray(rgbaData)) {
        rgbaData = Uint8ClampedArray.from(rgbaData);
      } else if (rgbaData && typeof rgbaData === 'object' && rgbaData.buffer) {
        rgbaData = new Uint8ClampedArray(rgbaData.buffer, rgbaData.byteOffset || 0, rgbaData.byteLength);
      }
      const byteLen = rgbaData ? rgbaData.byteLength : 0;
      if (!rgbaData || byteLen !== expectedBytes) {
        throw new Error(`Invalid tile buffer: expected ${expectedBytes} RGBA bytes (${tileW}x${tileH}), got ${byteLen}`);
      }
      const imgData = new ImageData(rgbaData, tileW, tileH);
      let bitmap = imgData;
      if (typeof createImageBitmap === 'function') {
        try {
          bitmap = await createImageBitmap(imgData);
        } catch (_) {
          bitmap = imgData;
        }
      }
      tileCache.set(key, bitmap);
      tileRenderError = null;
      return { key, data: bitmap };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error('[inkwell] render_tile error:', msg);
      tileRenderError = msg;
      tileCache.set(key, null);
      return null;
    } finally {
      tilesPending.delete(key);
    }
  })();
  tilesPending.set(key, task);
  return task;
}

// ---- Page background (white/dark paper rect with drop shadow and border) ----
function drawPageBackground(pl, pane = 'left') {
  if (!pl) return;
  const [sx0, sy0] = viewport.worldToScreen(pl.x, pl.y, pane);
  const [sx1, sy1] = viewport.worldToScreen(pl.x + pl.width, pl.y + pl.height, pane);

  const pi = state.pageInfos && state.pageInfos[pl.sheet];
  const template = (pi && pi.template) ? pi.template : 'blank';
  const isDark = template === 'dark';

  tctx.save();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.scale(state.dpr, state.dpr);
  clipToPane(tctx, pane);

  // Paper drop shadow
  tctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  tctx.shadowBlur = 20;
  tctx.shadowOffsetY = 6;
  tctx.fillStyle = isDark ? '#0f172a' : '#ffffff';
  tctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);

  tctx.shadowBlur = 0;
  tctx.shadowOffsetY = 0;

  // Subtle page border
  tctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.15)';
  tctx.lineWidth = 1;
  tctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);

  tctx.restore();
}

// ---- Vector Note Template Guidelines (Rendered on Dry Canvas above Tiles) ----
function drawPageTemplateGuidelines(ctx, template, width, height) {
  if (!template || template === 'blank') return;
  const isDark = template === 'dark';

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();

  if (template === 'ruled') {
    const lineGap = 28;
    const marginX = 72;
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(203, 213, 225, 0.85)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let y = 60; y < height - 20; y += lineGap) {
      ctx.moveTo(20, y);
      ctx.lineTo(width - 20, y);
    }
    ctx.stroke();

    // Left red margin line
    ctx.strokeStyle = isDark ? 'rgba(244, 63, 94, 0.45)' : 'rgba(248, 113, 113, 0.7)';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(marginX, 20);
    ctx.lineTo(marginX, height - 20);
    ctx.stroke();
  } else if (template === 'grid' || template === 'dark') {
    const gridGap = 20;
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(203, 213, 225, 0.75)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let x = gridGap; x < width; x += gridGap) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = gridGap; y < height; y += gridGap) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  } else if (template === 'dot') {
    const dotGap = 20;
    const dotR = 1.0;
    ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(148, 163, 184, 0.8)';
    for (let x = dotGap; x < width; x += dotGap) {
      for (let y = dotGap; y < height; y += dotGap) {
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (template === 'cornell') {
    const headerH = 72;
    const footerH = 108;
    const cueW = Math.max(120, width * 0.28);
    const lineGap = 26;

    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(148, 163, 184, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(20, headerH); ctx.lineTo(width - 20, headerH);
    ctx.moveTo(20, height - footerH); ctx.lineTo(width - 20, height - footerH);
    ctx.moveTo(cueW, headerH); ctx.lineTo(cueW, height - footerH);
    ctx.stroke();

    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(226, 232, 240, 0.8)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let y = headerH + lineGap; y < height - footerH - 10; y += lineGap) {
      ctx.moveTo(cueW + 10, y);
      ctx.lineTo(width - 20, y);
    }
    ctx.stroke();

    ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(100, 116, 139, 0.6)';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.fillText('DATE / TOPIC', 24, headerH - 12);
    ctx.fillText('CUES / QUESTIONS', 24, headerH + 18);
    ctx.fillText('NOTES', cueW + 14, headerH + 18);
    ctx.fillText('SUMMARY', 24, height - footerH + 18);
  }

  ctx.restore();
}

function renderPageTemplateBackgroundToDataUrl(pi, sheetIdx) {
  const canvas = document.createElement('canvas');
  const dpr = 1;
  const width = pi.width_pt || 595.0;
  const height = pi.height_pt || 842.0;

  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  if (pi.template === 'dark') {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);
  }

  drawPageTemplateGuidelines(ctx, pi.template, width, height);

  return {
    sheet: sheetIdx,
    x: 0,
    y: 0,
    width,
    height,
    data_url: canvas.toDataURL('image/png'),
  };
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
  if (!tctx || !tilesCanvas) return;
  const drawEpoch = ++redrawTiles.epoch;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, tilesCanvas.width, tilesCanvas.height);

  for (const pane of visiblePanes()) {
    const visiblePages = viewport.getVisiblePages(pane);
    for (const pl of visiblePages) {
      drawPageBackground(pl, pane);
    }
    if (visiblePages.length) {
      await Promise.all(visiblePages.map(pl => {
        const pi = state.pageInfos[pl.sheet];
        return pi ? redrawTilesForPage(pane, pi, pl, drawEpoch) : Promise.resolve();
      }));
    }
  }

  drawZoomIndicator();
  updateDocScrollbar();
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

function drawTileData(data, tr, pl, pane, pi) {
  if (!data) return;
  // If page template is dark slate, do not paint opaque white tile over dark paper
  if (pi && pi.template === 'dark') return;

  const [sx0, sy0] = viewport.worldToScreen(pl.x + tr[0], pl.y + tr[1], pane);
  const [sx1, sy1] = viewport.worldToScreen(pl.x + tr[2], pl.y + tr[3], pane);
  const [pageX0, pageY0] = viewport.worldToScreen(pl.x, pl.y, pane);
  const [pageX1, pageY1] = viewport.worldToScreen(pl.x + pi.width_pt, pl.y + pi.height_pt, pane);

  tctx.save();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.scale(state.dpr, state.dpr);
  clipToPane(tctx, pane);
  tctx.beginPath();
  tctx.rect(pageX0, pageY0, pageX1 - pageX0, pageY1 - pageY0);
  tctx.clip();

  const dw = (sx1 - sx0) + 0.6;
  const dh = (sy1 - sy0) + 0.6;
  try {
    tctx.drawImage(data, sx0, sy0, dw, dh);
  } catch (_) {}
  tctx.restore();
}

async function redrawTilesForPage(pane, pi, pl, drawEpoch) {
  const bounds = paneBounds(pane);

  const [wx0, wy0] = viewport.screenToWorld(bounds.x, bounds.y, pane);
  const [wx1, wy1] = viewport.screenToWorld(bounds.x + bounds.width, bounds.y + bounds.height, pane);
  const rx0 = Math.max(0, wx0 - pl.x);
  const ry0 = Math.max(0, wy0 - pl.y);
  const rx1 = Math.min(pi.width_pt, wx1 - pl.x);
  const ry1 = Math.min(pi.height_pt, wy1 - pl.y);
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

    const trKey = `${pl.sheet}:${tr.join(',')}:${px}`;
    if (tileCache.has(trKey)) {
      await drawTileData(tileCache.get(trKey), tr, pl, pane, pi);
      return;
    }

    // Blit fallback cached tile immediately to prevent flicker during LOD fetch
    const fallback = findCachedTileFallback(pl.sheet, tr);
    if (fallback) {
      await drawTileData(fallback, tr, pl, pane, pi);
    }

    const result = await fetchTile(pl.sheet, tr, px);
    if (!result || !result.data) return;

    // Check if the page is still in the visible viewport before drawing
    const visibleNow = viewport.getVisiblePages(pane);
    if (visibleNow.some(v => v.sheet === pl.sheet)) {
      await drawTileData(result.data, tr, pl, pane, pi);
    }
  });

  await Promise.all(promises);
}

function makeCtx(canvas) {
  return canvas.getContext('2d', { desynchronized: true, alpha: true });
}

function resize() {
  updateStageRect();
  const r = stageRect;
  if (!r || r.width <= 0 || r.height <= 0) return;
  state.dpr = Math.max(1, window.devicePixelRatio || 1);

  for (const c of [tilesCanvas, dryCanvas, wetCanvas]) {
    if (!c) continue;
    c.width = Math.round(r.width * state.dpr);
    c.height = Math.round(r.height * state.dpr);
    c.style.width = r.width + 'px';
    c.style.height = r.height + 'px';
  }

  tctx = makeCtx(tilesCanvas);
  dctx = makeCtx(dryCanvas);
  wctx = makeCtx(wetCanvas);

  for (const ctx of [tctx, dctx, wctx]) {
    if (ctx) ctx.scale(state.dpr, state.dpr);
  }
  scheduleRedrawTiles();
  redrawAll();
  updateDocScrollbar();
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
  if (!dctx || !dryCanvas) return;
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, dryCanvas.width, dryCanvas.height);
  dctx.scale(state.dpr, state.dpr);

  if (!state.inkVisible) return;

  for (const pane of visiblePanes()) {
    const visiblePages = viewport.getVisiblePages(pane);
    dctx.save();
    clipToPane(dctx, pane);

    for (const pl of visiblePages) {
      dctx.save();
      const [psx, psy] = viewport.worldToScreen(pl.x, pl.y, pane);
      const z = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
      dctx.translate(psx, psy);
      dctx.scale(z, z);

      // 0. Draw note template guidelines on sheet pl.sheet (if any)
      const pi = state.pageInfos && state.pageInfos[pl.sheet];
      if (pi && pi.template && pi.template !== 'blank') {
        drawPageTemplateGuidelines(dctx, pi.template, pl.width, pl.height);
      }

      // 1. Draw images on sheet pl.sheet
      if (state.images && state.images.length) {
        for (const img of state.images) {
          if (!img.deleted && img.sheet === pl.sheet && img._el) {
            try {
              dctx.drawImage(img._el, img.x, img.y, img.width, img.height);
            } catch (_) {}
          }
        }
      }

      // 2. Draw direct in-place text objects on sheet pl.sheet
      if (state.textObjects && state.textObjects.length) {
        for (const t of state.textObjects) {
          if (!t.deleted && t.sheet === pl.sheet && t.text) {
            dctx.save();
            dctx.fillStyle = t.color || '#141724';
            const weight = t.bold ? 'bold ' : '';
            const slant = t.italic ? 'italic ' : '';
            const size = t.fontSize || 16;
            dctx.font = `${slant}${weight}${size}px Inter, system-ui, -apple-system, sans-serif`;
            dctx.textBaseline = 'top';
            const lines = (t.text || '').split('\n');
            const lineHeight = size * 1.35;
            let maxW = 0;
            lines.forEach((line, idx) => {
              const lineW = dctx.measureText(line).width;
              if (lineW > maxW) maxW = lineW;
              dctx.fillText(line, t.x, t.y + idx * lineHeight);
            });
            t.width = Math.max(10, maxW);
            t.height = Math.max(10, lines.length * lineHeight);
            dctx.restore();
          }
        }
      }

      // 3. Draw ink strokes on sheet pl.sheet
      for (const s of state.strokes) {
        if (!s.deleted && s.sheet === pl.sheet) {
          Ink.drawStroke(dctx, s);
        }
      }

      dctx.restore();
    }
    dctx.restore();
  }

  // Draw lasso / selection overlay
  drawLassoOverlay();
}

function drawCommittedStroke(stroke) {
  if (!dctx) return;
  const pl = viewport.getPageLayout(stroke.sheet);
  for (const pane of visiblePanes()) {
    dctx.save();
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.scale(state.dpr, state.dpr);
    clipToPane(dctx, pane);
    const [psx, psy] = viewport.worldToScreen(pl.x, pl.y, pane);
    const z = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
    dctx.translate(psx, psy);
    dctx.scale(z, z);
    Ink.drawStroke(dctx, stroke);
    dctx.restore();
  }
}

function clearWet() {
  if (!wctx || !wetCanvas) return;
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.clearRect(0, 0, wetCanvas.width, wetCanvas.height);
  wctx.scale(state.dpr, state.dpr);
}

function localXY(e, pane = state.drawingPane || paneForEvent(e)) {
  const r = stageRect || (wetCanvas ? (stageRect = wetCanvas.getBoundingClientRect()) : { left: 0, top: 0 });
  return viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top, pane);
}

// ---- Page navigation & pre-fetching ----
let prefetchTimer = null;
function prefetchAdjacentPages() {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    if (!state.pageInfos || !state.pageInfos.length) return;
    const curr = state.leftSheet;
    const total = state.pageInfos.length;
    const adjacentSheets = [curr - 1, curr + 1].filter(s => s >= 0 && s < total);

    for (const sheetIdx of adjacentSheets) {
      const pi = state.pageInfos[sheetIdx];
      if (!pi) continue;
      const tr = [0, 0, pi.width_pt, pi.height_pt];
      fetchTile(sheetIdx, tr, 512).catch(() => {});
    }
  }, 250);
}

function goToPage(i, pane = 'left') {
  if (i < 0 || i >= state.pageInfos.length) return;
  // Record primary-pane navigation in the header Back/Forward history.
  if (pane !== 'right' || !viewport.splitMode) pushNav(i);
  if (pane === 'right' && viewport.splitMode) {
    state.rightSheet = i;
  } else {
    state.leftSheet = i;
  }
  viewport.scrollToPage(i, pane);
  updatePageUI();
  scheduleRedrawTiles();
  redrawAll();
  updateDocScrollbar();
  prefetchAdjacentPages();
}

function fitPageInPanes(piLeft = state.pageInfos[state.leftSheet], piRight = state.pageInfos[state.rightSheet]) {
  if (!piLeft) return;
  if (viewport && !viewport.stageRect) viewport.updateStageRect();
  const r = stageRect || (wetCanvas ? wetCanvas.getBoundingClientRect() : null);
  const stageW = r ? r.width : (tilesCanvas.width / state.dpr);
  const stageH = r ? r.height : (tilesCanvas.height / state.dpr);
  const margin = 40;

  const maxW = viewport.maxDocWidth || piLeft.width_pt || 595.0;

  if (viewport.splitMode && piRight) {
    const halfW = stageW / 2;
    const availW = Math.max(100, halfW - margin);
    const availH = Math.max(100, stageH - margin);

    const fitZoomLeft = Math.max(0.2, Math.min(4.0, Math.min(availW / maxW, availH / piLeft.height_pt)));
    const fitZoomRight = Math.max(0.2, Math.min(4.0, Math.min(availW / maxW, availH / piRight.height_pt)));
    const fitZoom = Math.min(fitZoomLeft, fitZoomRight);

    viewport.zoom = fitZoom;
    viewport.rightZoom = fitZoom;

    const layoutLeft = viewport.getPageLayout(state.leftSheet);
    const layoutRight = viewport.getPageLayout(state.rightSheet);

    viewport.panX = Math.round((halfW - maxW * fitZoom) / 2);
    viewport.panY = Math.round(-layoutLeft.y * fitZoom + 30);

    viewport.rightPanX = Math.round(halfW + (halfW - maxW * fitZoom) / 2);
    viewport.rightPanY = Math.round(-layoutRight.y * fitZoom + 30);
  } else {
    const availW = Math.max(100, stageW - margin);
    const availH = Math.max(100, stageH - margin);
    const fitZoom = Math.max(0.2, Math.min(4.0, Math.min(availW / maxW, availH / piLeft.height_pt)));
    viewport.zoom = fitZoom;
    const layoutLeft = viewport.getPageLayout(state.leftSheet);
    viewport.panX = Math.round((stageW - maxW * fitZoom) / 2);
    viewport.panY = Math.round(-layoutLeft.y * fitZoom + 30);
  }
}

function recenterPanesOnly(piLeft = state.pageInfos[state.leftSheet], piRight = state.pageInfos[state.rightSheet]) {
  if (!piLeft) return;
  const r = stageRect || (wetCanvas ? wetCanvas.getBoundingClientRect() : null);
  const stageW = r ? r.width : (tilesCanvas.width / state.dpr);
  const maxW = viewport.maxDocWidth || piLeft.width_pt || 595.0;

  const layoutLeft = viewport.getPageLayout(state.leftSheet);
  if (viewport.splitMode && piRight) {
    const halfW = stageW / 2;
    const layoutRight = viewport.getPageLayout(state.rightSheet);
    viewport.panX = Math.round((halfW - maxW * viewport.zoom) / 2);
    viewport.panY = Math.round(-layoutLeft.y * viewport.zoom + 30);
    viewport.rightPanX = Math.round(halfW + (halfW - maxW * viewport.rightZoom) / 2);
    viewport.rightPanY = Math.round(-layoutRight.y * viewport.rightZoom + 30);
  } else {
    viewport.panX = Math.round((stageW - maxW * viewport.zoom) / 2);
    viewport.panY = Math.round(-layoutLeft.y * viewport.zoom + 30);
  }
}

function centerPageInPanes(piLeft = state.pageInfos[state.leftSheet], piRight = state.pageInfos[state.rightSheet]) {
  fitPageInPanes(piLeft, piRight);
}

function syncActivePagesFromViewport() {
  if (!viewport || !state.pageInfos || !state.pageInfos.length) return;
  const leftActive = viewport.getActivePageInView('left');
  const rightActive = viewport.splitMode ? viewport.getActivePageInView('right') : leftActive;
  let changed = false;
  if (state.leftSheet !== leftActive) {
    state.leftSheet = leftActive;
    changed = true;
  }
  if (viewport.splitMode && state.rightSheet !== rightActive) {
    state.rightSheet = rightActive;
    changed = true;
  }
  if (changed) {
    updatePageUI();
    // Keep thumbnail active card highlighted for the page in view
    const thumbs = document.querySelectorAll('.thumb-card');
    thumbs.forEach(card => {
      const p = parseInt(card.getAttribute('data-page'), 10);
      const isActive = p === state.leftSheet || (viewport.splitMode && p === state.rightSheet);
      card.classList.toggle('active', isActive);
    });
  }
}

function updatePageUI() {
  const total = state.pageInfos ? state.pageInfos.length : 0;
  const isSplit = !!(viewport && viewport.splitMode);

  if (!total) {
    $('pageNum') && ($('pageNum').textContent = '—');
    if ($('pageNumDisplay')) $('pageNumDisplay').textContent = '—';
    if ($('pageTotalDisplay')) $('pageTotalDisplay').textContent = '—';
    $('btnPrev') && ($('btnPrev').disabled = true);
    $('btnNext') && ($('btnNext').disabled = true);
    $('btnHeaderPrevPage') && ($('btnHeaderPrevPage').disabled = true);
    $('btnHeaderNextPage') && ($('btnHeaderNextPage').disabled = true);
    if ($('btnCanvasPrevPage')) $('btnCanvasPrevPage').classList.add('hidden');
    if ($('btnCanvasNextPage')) $('btnCanvasNextPage').classList.add('hidden');
    $('splitPageNav') && $('splitPageNav').classList.add('hidden');
    $('splitPageNavCluster') && $('splitPageNavCluster').classList.add('hidden');
    $('pageNavCluster') && $('pageNavCluster').classList.remove('hidden');
    return;
  }

  const leftCur = state.leftSheet + 1;
  const rightCur = state.rightSheet + 1;

  $('pageNum') && ($('pageNum').textContent = isSplit ? `${leftCur}` : `${leftCur} / ${total}`);
  if ($('pageNumDisplay')) $('pageNumDisplay').textContent = `${leftCur}`;
  if ($('pageTotalDisplay')) $('pageTotalDisplay').textContent = `${total}`;

  // Header navigation flippers
  const leftPrevDisabled = state.leftSheet <= 0;
  const leftNextDisabled = state.leftSheet >= total - 1;
  const rightPrevDisabled = state.rightSheet <= 0;
  const rightNextDisabled = state.rightSheet >= total - 1;

  $('btnPrev') && ($('btnPrev').disabled = leftPrevDisabled);
  $('btnNext') && ($('btnNext').disabled = leftNextDisabled);
  $('btnHeaderPrevPage') && ($('btnHeaderPrevPage').disabled = leftPrevDisabled);
  $('btnHeaderNextPage') && ($('btnHeaderNextPage').disabled = leftNextDisabled);

  // Stage edge flippers: In split mode, left edge navigates left pane, right edge navigates right pane!
  if ($('btnCanvasPrevPage')) {
    $('btnCanvasPrevPage').disabled = leftPrevDisabled;
    $('btnCanvasPrevPage').classList.toggle('hidden', leftPrevDisabled);
  }
  if ($('btnCanvasNextPage')) {
    const nextEdgeDisabled = isSplit ? rightNextDisabled : leftNextDisabled;
    $('btnCanvasNextPage').disabled = nextEdgeDisabled;
    $('btnCanvasNextPage').classList.toggle('hidden', nextEdgeDisabled);
  }

  // Split view header controls
  $('pageNavCluster') && $('pageNavCluster').classList.toggle('hidden', isSplit);
  $('splitPageNav') && $('splitPageNav').classList.toggle('hidden', !isSplit);
  $('splitPageNavCluster') && $('splitPageNavCluster').classList.toggle('hidden', !isSplit);

  if (isSplit) {
    $('leftPanePageNum') && ($('leftPanePageNum').textContent = `${leftCur}`);
    $('rightPanePageNum') && ($('rightPanePageNum').textContent = `${rightCur}`);
    $('btnLeftPanePrev') && ($('btnLeftPanePrev').disabled = leftPrevDisabled);
    $('btnLeftPaneNext') && ($('btnLeftPaneNext').disabled = leftNextDisabled);
    $('btnRightPanePrev') && ($('btnRightPanePrev').disabled = rightPrevDisabled);
    $('btnRightPaneNext') && ($('btnRightPaneNext').disabled = rightNextDisabled);
    $('rightPageNum') && ($('rightPageNum').textContent = `${rightCur}`);
    $('btnRightPrev') && ($('btnRightPrev').disabled = rightPrevDisabled);
    $('btnRightNext') && ($('btnRightNext').disabled = rightNextDisabled);
  }

  // Update thumbnail badge in nav rail
  updateToolBadges();
  updateZoomUI();
}

function updateToolInspectorUI() {
  const pop = $('propPopover');
  if (!pop) return;
  const tool = state.activeTool || 'pen';
  const icon = $('popoverToolIcon');
  const title = $('popoverToolTitle');
  const previewWrap = $('popoverStrokePreviewWrap');
  const colorSection = $('popoverColorSection');

  const toolConfig = {
    pen: { title: 'Pen Properties', icon: '🖊️', hasColor: true, hasPreview: true },
    highlighter: { title: 'Highlighter Properties', icon: '🖍️', hasColor: true, hasPreview: true },
    eraser: { title: 'Eraser Properties', icon: '🧹', hasColor: false, hasPreview: false },
    laser: { title: 'Laser Pointer', icon: '🔴', hasColor: false, hasPreview: false },
    rect: { title: 'Rectangle Tool', icon: '▭', hasColor: true, hasPreview: true },
    ellipse: { title: 'Ellipse Tool', icon: '◯', hasColor: true, hasPreview: true },
    ruler: { title: 'Ruler / Line', icon: '📐', hasColor: true, hasPreview: true },
    text: { title: 'Text Properties', icon: '🔤', hasColor: true, hasPreview: false },
    lasso: { title: 'Lasso Selection', icon: '⬚', hasColor: false, hasPreview: false },
    pan: { title: 'Hand / Pan Tool', icon: '🖐️', hasColor: false, hasPreview: false },
  };

  const cfg = toolConfig[tool] || { title: 'Tool Properties', icon: '⚙️', hasColor: true, hasPreview: true };
  if (title) title.textContent = cfg.title;
  if (icon) icon.textContent = cfg.icon;
  if (previewWrap) previewWrap.style.display = cfg.hasPreview ? 'flex' : 'none';
  if (colorSection) colorSection.style.display = cfg.hasColor ? 'flex' : 'none';

  if ($('popoverWidthSlider')) {
    $('popoverWidthSlider').value = String(state.baseWidth || 1.6);
  }
  if ($('popoverWidthVal')) {
    $('popoverWidthVal').textContent = (state.baseWidth || 1.6) + ' pt';
  }

  // Update preset buttons active state
  document.querySelectorAll('.btn-width-preset').forEach(btn => {
    const w = parseFloat(btn.getAttribute('data-width'));
    btn.classList.toggle('active', Math.abs(w - (state.baseWidth || 1.6)) < 0.15);
  });

  drawStrokePreview();
}

function drawStrokePreview() {
  const canvas = $('strokePreviewCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width;
  const h = canvas.height;
  const strokeW = Math.max(1.0, Math.min(24, (state.baseWidth || 1.6) * 1.5));
  const isHighlighter = state.activeTool === 'highlighter';

  ctx.save();
  ctx.lineCap = isHighlighter ? 'square' : 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = strokeW;

  const hex = Array.isArray(state.color) ? rgbToHex(state.color) : (state.color || '#141724');
  if (isHighlighter) {
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = hex;
  } else {
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = hex;
  }

  ctx.beginPath();
  ctx.moveTo(24, h / 2);
  ctx.bezierCurveTo(w * 0.35, h / 2 - 10, w * 0.65, h / 2 + 10, w - 24, h / 2);
  ctx.stroke();
  ctx.restore();
}

// ---- Eraser (stroke-erase by proximity in continuous document space) ----
function eraseStrokesAt(e) {
  const pane = state.drawingPane || paneForEvent(e);
  const [wx, wy] = localXY(e, pane);
  const pageCoord = viewport.worldToPage(wx, wy);
  const targetSheet = pageCoord.sheet;
  const eraserZoom = (pane === 'right' && viewport.splitMode) ? viewport.rightZoom : viewport.zoom;
  const radius = 16 / (eraserZoom || 1);
  const qMinX = wx - radius;
  const qMaxX = wx + radius;
  const qMinY = wy - radius;
  const qMaxY = wy + radius;
  let erasedStrokes = [];

  // Check all strokes across all visible pages
  const visiblePages = viewport.getVisiblePages(pane);
  for (const pl of visiblePages) {
    for (const s of state.strokes) {
      if (s.deleted || s.sheet !== pl.sheet) continue;
      if (!s.bbox && s.points) {
        s.bbox = (Ink.computeStrokeBbox || computeStrokeBbox)(s.points, s.base_width);
      }
      if (s.bbox) {
        const sWorldMinX = pl.x + s.bbox[0];
        const sWorldMinY = pl.y + s.bbox[1];
        const sWorldMaxX = pl.x + s.bbox[2];
        const sWorldMaxY = pl.y + s.bbox[3];
        if (sWorldMaxX < qMinX || sWorldMinX > qMaxX || sWorldMaxY < qMinY || sWorldMinY > qMaxY) {
          continue;
        }
      }
      for (const pt of s.points) {
        const strokeWorldX = pl.x + pt.x;
        const strokeWorldY = pl.y + pt.y;
        if (Math.hypot(strokeWorldX - wx, strokeWorldY - wy) < radius + (pt.w || 2) / 2) {
          s.deleted = true;
          erasedStrokes.push(s);
          break;
        }
      }
    }
  }

  if (erasedStrokes.length) {
    state.undoStack.push({ type: 'delete_objects', strokes: erasedStrokes, images: [] });
    state.redoStack = [];
    redrawAll();
    const invoke = getInvoke();
    if (invoke) {
      invoke('erase_strokes_near', {
        sheet: targetSheet,
        px: pageCoord.px,
        py: pageCoord.py,
        radius: radius,
      }).catch(err => console.warn('erase IPC failed:', err));
    }
    markDirty();
  }
}

// ---- consume (wet layer drawing) ----
function consume(e) {
  if (!wctx) return;
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
  wctx.fillStyle = state.cur.cssColor || `rgb(${state.cur.rgb.map(v => Math.round(v * 255)).join(',')})`;
  if (state.cur.kind === 'highlighter') {
    wctx.globalCompositeOperation = 'multiply';
    wctx.globalAlpha = 0.42;
  }
  if (prev) Ink.drawSegment(wctx, prev, pt);
  else Ink.drawDot(wctx, pt);
  wctx.restore();
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

// ---- Polygon Point-in-Polygon Hit-Testing (Ray casting) ----
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

// ---- Selection Bounds & Transform Handles ----
function getSelectionBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasItems = false;

  if (state.selectedStrokes && state.selectedStrokes.length) {
    for (const s of state.selectedStrokes) {
      if (s.deleted) continue;
      const pl = viewport.getPageLayout(s.sheet);
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
      const pl = viewport.getPageLayout(img.sheet);
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
      const pl = viewport.getPageLayout(t.sheet);
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

function getSelectionHandleAt(screenX, screenY) {
  const bounds = getSelectionBounds();
  if (!bounds) return null;
  const pad = 6;
  const [sx0, sy0] = viewport.worldToScreen(bounds.x0 - pad, bounds.y0 - pad, state.drawingPane);
  const [sx1, sy1] = viewport.worldToScreen(bounds.x1 + pad, bounds.y1 + pad, state.drawingPane);
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

  // Inside bounding box -> move handle
  if (screenX >= sx0 && screenX <= sx1 && screenY >= sy0 && screenY <= sy1) {
    return { name: 'move', cursor: 'move' };
  }
  return null;
}

function findObjectAtWorld(wx, wy, radius = 10) {
  const pageCoord = viewport.worldToPage(wx, wy);
  const targetSheet = pageCoord.sheet;
  const pl = viewport.getPageLayout(targetSheet);

  const qMinX = wx - radius;
  const qMaxX = wx + radius;
  const qMinY = wy - radius;
  const qMaxY = wy + radius;

  // 0. Check direct text objects on this sheet (top to bottom)
  if (state.textObjects && state.textObjects.length) {
    for (let i = state.textObjects.length - 1; i >= 0; i--) {
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
  }

  // 1. Check images on this sheet (top to bottom)
  if (state.images && state.images.length) {
    for (let i = state.images.length - 1; i >= 0; i--) {
      const img = state.images[i];
      if (img.deleted || img.sheet !== targetSheet) continue;
      const x0 = pl.x + img.x;
      const y0 = pl.y + img.y;
      if (wx >= x0 && wx <= x0 + img.width && wy >= y0 && wy <= y0 + img.height) {
        return { type: 'image', item: img };
      }
    }
  }

  // 2. Check strokes on this sheet (in reverse order)
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (s.deleted || s.sheet !== targetSheet) continue;
    if (!s.bbox && s.points) {
      s.bbox = (Ink.computeStrokeBbox || computeStrokeBbox)(s.points, s.base_width);
    }
    if (s.bbox) {
      const sWorldMinX = pl.x + s.bbox[0];
      const sWorldMinY = pl.y + s.bbox[1];
      const sWorldMaxX = pl.x + s.bbox[2];
      const sWorldMaxY = pl.y + s.bbox[3];
      if (sWorldMaxX < qMinX || sWorldMinX > qMaxX || sWorldMaxY < qMinY || sWorldMinY > qMaxY) {
        continue;
      }
    }
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

// ---- Lasso & Selection Overlay ----
function drawLassoOverlay() {
  if (!wctx || !wetCanvas) return;
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.scale(state.dpr, state.dpr);

  // 1. Freeform lasso drawing in progress
  if (state.lassoPath && state.lassoPath.length > 1) {
    wctx.strokeStyle = 'rgba(99, 102, 241, 0.9)';
    wctx.fillStyle = 'rgba(99, 102, 241, 0.12)';
    wctx.lineWidth = 2;
    wctx.setLineDash([6, 4]);

    wctx.beginPath();
    const [startSx, startSy] = viewport.worldToScreen(state.lassoPath[0][0], state.lassoPath[0][1], state.drawingPane);
    wctx.moveTo(startSx, startSy);
    for (let i = 1; i < state.lassoPath.length; i++) {
      const [sx, sy] = viewport.worldToScreen(state.lassoPath[i][0], state.lassoPath[i][1], state.drawingPane);
      wctx.lineTo(sx, sy);
    }
    wctx.closePath();
    wctx.fill();
    wctx.stroke();
  }

  // 2. Selection bounding box with transform handles
  const bounds = getSelectionBounds();
  const selToolbar = $('selectionToolbar');

  if (bounds) {
    const pad = 6;
    const [sx0, sy0] = viewport.worldToScreen(bounds.x0 - pad, bounds.y0 - pad, state.drawingPane);
    const [sx1, sy1] = viewport.worldToScreen(bounds.x1 + pad, bounds.y1 + pad, state.drawingPane);

    wctx.strokeStyle = '#6366f1';
    wctx.fillStyle = 'rgba(99, 102, 241, 0.06)';
    wctx.lineWidth = 1.5;
    wctx.setLineDash([6, 4]);
    wctx.beginPath();
    wctx.rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    wctx.fill();
    wctx.stroke();

    // Draw 8 handles: 4 corners + 4 midpoints
    const midSx = (sx0 + sx1) / 2;
    const midSy = (sy0 + sy1) / 2;
    const handlePts = [
      [sx0, sy0], [midSx, sy0], [sx1, sy0],
      [sx1, midSy], [sx1, sy1], [midSx, sy1],
      [sx0, sy1], [sx0, midSy]
    ];

    wctx.fillStyle = '#ffffff';
    wctx.strokeStyle = '#4f46e5';
    wctx.lineWidth = 2;
    wctx.setLineDash([]);

    for (const [hx, hy] of handlePts) {
      wctx.beginPath();
      wctx.arc(hx, hy, 5, 0, Math.PI * 2);
      wctx.fill();
      wctx.stroke();
    }

    // Position floating selection toolbar above top edge
    if (selToolbar) {
      selToolbar.classList.remove('hidden');
      const tbX = Math.max(10, midSx - (selToolbar.offsetWidth / 2 || 90));
      const tbY = Math.max(10, sy0 - 44);
      selToolbar.style.left = `${tbX}px`;
      selToolbar.style.top = `${tbY}px`;
    }
  } else {
    if (selToolbar) selToolbar.classList.add('hidden');
  }

  wctx.restore();
}

// ---- Selection & Clipboard Operations ----
function selectAllOnCurrentPage() {
  const activeSheet = viewport.getActivePageInView(state.drawingPane || 'left');
  state.currentSheet = activeSheet;

  const strokesOnSheet = state.strokes.filter(s => !s.deleted && s.sheet === activeSheet);
  const imagesOnSheet = (state.images || []).filter(img => !img.deleted && img.sheet === activeSheet);
  const textsOnSheet = (state.textObjects || []).filter(t => !t.deleted && t.sheet === activeSheet);

  state.selectedStrokes = strokesOnSheet;
  state.selectedImages = imagesOnSheet;
  state.selectedTextObjects = textsOnSheet;

  const count = strokesOnSheet.length + imagesOnSheet.length + textsOnSheet.length;
  if (count > 0) {
    setTool('lasso');
    clearWet();
    drawLassoOverlay();
    showToast(`Selected ${count} objects on Page ${activeSheet + 1}`, 'info');
  } else {
    showToast(`No objects to select on Page ${activeSheet + 1}`, 'info');
  }
}

function copySelection() {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);
  if (!strokes.length && !images.length && !texts.length) return false;

  state.clipboard = {
    type: 'inkwell_objects',
    strokes: strokes.map(s => JSON.parse(JSON.stringify(s))),
    images: images.map(img => JSON.parse(JSON.stringify(img))),
    texts: texts.map(t => JSON.parse(JSON.stringify(t))),
  };

  showToast(`Copied ${strokes.length + images.length + texts.length} objects`, 'info');
  return true;
}

function cutSelection() {
  if (!copySelection()) return;
  deleteSelection();
  showToast('Cut selection to clipboard', 'info');
}

function deleteSelection() {
  const deletedStrokes = [];
  const invoke = getInvoke();
  for (const s of (state.selectedStrokes || [])) {
    if (!s.deleted) {
      s.deleted = true;
      deletedStrokes.push(s);
      if (invoke && s.id) {
        invoke('delete_stroke', { strokeIdStr: String(s.id) }).catch(() => {});
      }
    }
  }

  const deletedImages = [];
  for (const img of (state.selectedImages || [])) {
    if (!img.deleted) {
      img.deleted = true;
      deletedImages.push(img);
    }
  }

  const deletedTexts = [];
  for (const t of (state.selectedTextObjects || [])) {
    if (!t.deleted) {
      t.deleted = true;
      deletedTexts.push(t);
    }
  }

  if (deletedStrokes.length || deletedImages.length || deletedTexts.length) {
    state.undoStack.push({
      type: 'delete_objects',
      strokes: deletedStrokes,
      images: deletedImages,
      textObjects: deletedTexts,
    });
    state.redoStack = [];
    state.selectedStrokes = [];
    state.selectedImages = [];
    state.selectedTextObjects = [];
    clearWet();
    redrawAll();
    if (typeof updateUndoRedoUI === 'function') updateUndoRedoUI();
  }
}

function duplicateSelection() {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);
  if (!strokes.length && !images.length && !texts.length) return;

  const offset = 18;
  const newStrokes = [];
  const newImages = [];
  const newTexts = [];
  const invoke = getInvoke();

  for (const s of strokes) {
    const clone = JSON.parse(JSON.stringify(s));
    clone.id = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    clone.points.forEach(p => { p.x += offset; p.y += offset; });
    if (typeof Ink.getPath2D === 'function') {
      clone._cachedPath2D = Ink.getPath2D(clone);
    }
    state.strokes.push(clone);
    newStrokes.push(clone);

    if (invoke) {
      const samplesPayload = (clone.points || []).map(pt => ({
        x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
      }));
      invoke('commit_stroke', {
        sheet: clone.sheet || 0,
        tool: clone.kind || 'pen',
        rgb: clone.rgb || [0.08, 0.09, 0.14],
        baseWidth: clone.base_width || 1.6,
        samples: samplesPayload,
      }).catch(() => {});
    }
  }

  for (const img of images) {
    const clone = JSON.parse(JSON.stringify(img));
    clone.id = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    clone.x += offset;
    clone.y += offset;
    const imgEl = new Image();
    imgEl.src = clone.dataUrl;
    clone._el = imgEl;
    if (!state.images) state.images = [];
    state.images.push(clone);
    newImages.push(clone);
  }

  for (const t of texts) {
    const clone = JSON.parse(JSON.stringify(t));
    clone.id = 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    clone.x += offset;
    clone.y += offset;
    if (!state.textObjects) state.textObjects = [];
    state.textObjects.push(clone);
    newTexts.push(clone);
  }

  state.undoStack.push({
    type: 'add_objects',
    strokes: newStrokes,
    images: newImages,
    textObjects: newTexts,
  });
  state.redoStack = [];

  state.selectedStrokes = newStrokes;
  state.selectedImages = newImages;

  clearWet();
  redrawAll();
  drawLassoOverlay();
  if (typeof updateUndoRedoUI === 'function') updateUndoRedoUI();
  showToast('Duplicated selection', 'info');
}

function applyColorToSelection(rgb) {
  if (state.selectedStrokes && state.selectedStrokes.length) {
    const beforeStrokes = state.selectedStrokes.map(s => ({ id: s.id, rgb: [...(s.rgb || [0, 0, 0])] }));
    for (const s of state.selectedStrokes) {
      s.rgb = rgb;
      s._cachedPath2D = null;
    }
    state.undoStack.push({
      type: 'style_change',
      strokes: beforeStrokes,
      newRgb: rgb,
    });
    state.redoStack = [];
    redrawAll();
    drawLassoOverlay();
    if (typeof updateUndoRedoUI === 'function') updateUndoRedoUI();
  }
}

function applyWidthToSelection(newWidth) {
  if (state.selectedStrokes && state.selectedStrokes.length) {
    const beforeStrokes = state.selectedStrokes.map(s => ({
      id: s.id,
      base_width: s.base_width,
      points: s.points.map(p => ({ ...p })),
    }));
    for (const s of state.selectedStrokes) {
      const oldBase = s.base_width || 1.6;
      const ratio = newWidth / oldBase;
      s.base_width = newWidth;
      if (s.points) {
        for (const p of s.points) {
          if (p.w != null) p.w *= ratio;
        }
      }
      s._cachedPath2D = null;
    }
    state.undoStack.push({
      type: 'width_change',
      strokes: beforeStrokes,
      newWidth: newWidth,
    });
    state.redoStack = [];
    redrawAll();
    drawLassoOverlay();
    if (typeof updateUndoRedoUI === 'function') updateUndoRedoUI();
  }
}

function pasteClipboard() {
  if (!state.clipboard || state.clipboard.type !== 'inkwell_objects') {
    return false;
  }

  const activeSheet = viewport.getActivePageInView(state.drawingPane || 'left');
  const offset = 16;
  const newStrokes = [];
  const newImages = [];
  const invoke = getInvoke();

  for (const s of (state.clipboard.strokes || [])) {
    const clone = JSON.parse(JSON.stringify(s));
    clone.id = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    clone.sheet = activeSheet;
    clone.points.forEach(p => { p.x += offset; p.y += offset; });
    if (typeof Ink.getPath2D === 'function') {
      clone._cachedPath2D = Ink.getPath2D(clone);
    }
    state.strokes.push(clone);
    newStrokes.push(clone);

    if (invoke) {
      const samplesPayload = (clone.points || []).map(pt => ({
        x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
      }));
      invoke('commit_stroke', {
        sheet: clone.sheet || 0,
        tool: clone.kind || 'pen',
        rgb: clone.rgb || [0.08, 0.09, 0.14],
        baseWidth: clone.base_width || 1.6,
        samples: samplesPayload,
      }).catch(() => {});
    }
  }

  for (const img of (state.clipboard.images || [])) {
    const clone = JSON.parse(JSON.stringify(img));
    clone.id = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    clone.sheet = activeSheet;
    clone.x += offset;
    clone.y += offset;
    const imgEl = new Image();
    imgEl.src = clone.dataUrl;
    clone._el = imgEl;
    if (!state.images) state.images = [];
    state.images.push(clone);
    newImages.push(clone);
  }

  state.undoStack.push({
    type: 'add_objects',
    strokes: newStrokes,
    images: newImages,
  });
  state.redoStack = [];

  state.selectedStrokes = newStrokes;
  state.selectedImages = newImages;

  clearWet();
  redrawAll();
  drawLassoOverlay();
  if (typeof updateUndoRedoUI === 'function') updateUndoRedoUI();
  showToast(`Pasted ${newStrokes.length + newImages.length} objects`, 'success');
  return true;
}

// ---- Image Pasting from System Clipboard ----
async function handleGlobalPaste(e) {
  const activeEl = document.activeElement;
  const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
  if (isTyping) return;

  const clipboardData = e.clipboardData || window.clipboardData;
  if (!clipboardData) return;

  const items = clipboardData.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') !== -1) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = evt => {
            const dataUrl = evt.target.result;
            insertPastedImage(dataUrl);
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
    }
  }

  // If no system image, paste internal clipboard
  if (pasteClipboard()) {
    e.preventDefault();
  }
}

function insertPastedImage(dataUrl) {
  const imgEl = new Image();
  imgEl.onload = () => {
    const activeSheet = viewport.getActivePageInView(state.drawingPane || 'left');
    const pl = viewport.getPageLayout(activeSheet);
    
    let w = imgEl.naturalWidth || 300;
    let h = imgEl.naturalHeight || 200;
    const maxW = Math.min(420, pl.width * 0.75);
    if (w > maxW) {
      const ratio = maxW / w;
      w = maxW;
      h = h * ratio;
    }

    const x = Math.max(20, (pl.width - w) / 2);
    const y = Math.max(20, (pl.height - h) / 3);

    const imgObj = {
      id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      sheet: activeSheet,
      x,
      y,
      width: w,
      height: h,
      dataUrl,
      _el: imgEl,
      deleted: false,
    };

    if (!state.images) state.images = [];
    state.images.push(imgObj);
    journalImageMutation('add', imgObj);
    markDirty();

    state.undoStack.push({
      type: 'add_image',
      image: imgObj,
    });
    state.redoStack = [];

    setTool('lasso');
    state.selectedStrokes = [];
    state.selectedImages = [imgObj];

    clearWet();
    redrawAll();
    drawLassoOverlay();
    showToast('Image pasted! Drag to move or drag corners to resize.', 'success');
  };
  imgEl.src = dataUrl;
}

// ---- Document Outline (TOC) Rendering ----
function renderOutline() {
  const container = $('outlineList');
  const emptyState = $('outlineEmptyState');
  if (!container) return;

  const outline = state.outline || [];
  if (!outline.length) {
    container.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  function renderTree(nodes, depth = 0) {
    return nodes.map(node => {
      const hasChildren = node.children && node.children.length > 0;
      const targetPage = node.page_index != null ? node.page_index : null;
      const pageLabel = targetPage != null ? `p. ${targetPage + 1}` : '';
      const childrenHtml = hasChildren ? `<div class="outline-children">${renderTree(node.children, depth + 1)}</div>` : '';
      
      return `
        <div class="outline-item" data-page="${targetPage != null ? targetPage : ''}">
          <div class="outline-header" data-page="${targetPage != null ? targetPage : ''}">
            <button class="outline-toggle ${hasChildren ? '' : 'leaf'}" title="Toggle section">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <span class="outline-title" title="${escapeHtml(node.title)}">${escapeHtml(node.title)}</span>
            ${pageLabel ? `<span class="outline-page-badge">${pageLabel}</span>` : ''}
          </div>
          ${childrenHtml}
        </div>
      `;
    }).join('');
  }

  container.innerHTML = renderTree(outline);

  // Click listeners for expand/collapse and page navigation
  container.querySelectorAll('.outline-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      btn.classList.toggle('collapsed');
      const children = btn.closest('.outline-item').querySelector('.outline-children');
      if (children) children.classList.toggle('hidden');
    });
  });

  container.querySelectorAll('.outline-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.closest('.outline-toggle')) return;
      const pageStr = header.dataset.page;
      if (pageStr !== '') {
        const pageIdx = parseInt(pageStr, 10);
        if (!isNaN(pageIdx)) {
          goToPage(pageIdx, 'left');
          container.querySelectorAll('.outline-item').forEach(el => el.classList.remove('active'));
          header.closest('.outline-item').classList.add('active');
        }
      }
    });
  });
}

// ---- Floating Right Document Scrollbar ----
function updateDocScrollbar() {
  const track = $('docScrollbarTrack');
  const thumb = $('docScrollbarThumb');
  if (!track || !thumb || !state.pageInfos.length) return;

  const trackH = track.clientHeight || 400;
  if (!stageRect) updateStageRect();
  const stageH = stageRect ? stageRect.height : 600;
  const docTotalH = (viewport.totalDocHeight || 800) * viewport.zoom;

  const thumbH = Math.max(28, Math.min(trackH, (stageH / Math.max(stageH, docTotalH)) * trackH));
  thumb.style.height = `${thumbH}px`;

  const maxPan = Math.max(1, docTotalH - stageH);
  const scrollPct = Math.max(0, Math.min(1, (-viewport.panY + 30) / maxPan));
  const thumbTop = scrollPct * (trackH - thumbH);
  thumb.style.top = `${thumbTop}px`;
}

function initDocScrollbar() {
  const scrollbar = $('docScrollbar');
  const track = $('docScrollbarTrack');
  const thumb = $('docScrollbarThumb');
  const tooltip = $('docScrollbarTooltip');
  if (!scrollbar || !track || !thumb) return;

  let isDraggingThumb = false;
  let startDragY = 0;
  let startPanY = 0;

  const onThumbDown = e => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingThumb = true;
    startDragY = e.clientY;
    startPanY = viewport.panY;
    scrollbar.classList.add('dragging');
    if (tooltip) tooltip.classList.remove('hidden');
    window.addEventListener('pointermove', onThumbMove);
    window.addEventListener('pointerup', onThumbUp);
  };

  const onThumbMove = e => {
    if (!isDraggingThumb) return;
    const dy = e.clientY - startDragY;
    const trackH = track.clientHeight;
    const docTotalH = (viewport.totalDocHeight || 800) * viewport.zoom;
    const stageH = stageRect ? stageRect.height : 600;
    const thumbH = thumb.clientHeight;
    const scrollableTrack = Math.max(1, trackH - thumbH);
    
    const panDelta = (dy / scrollableTrack) * (docTotalH - stageH);
    viewport.setPan(viewport.panX, startPanY - panDelta, 'left');
    scheduleRedrawTiles();
    redrawAll();
    updateDocScrollbar();

    const curPage = viewport.getActivePageInView('left');
    if (tooltip) {
      tooltip.textContent = `Page ${curPage + 1} / ${state.pageInfos.length || 1}`;
      tooltip.style.top = `${thumb.offsetTop + thumbH / 2}px`;
    }
  };

  const onThumbUp = () => {
    isDraggingThumb = false;
    scrollbar.classList.remove('dragging');
    if (tooltip) tooltip.classList.add('hidden');
    window.removeEventListener('pointermove', onThumbMove);
    window.removeEventListener('pointerup', onThumbUp);
  };

  thumb.addEventListener('pointerdown', onThumbDown);

  track.addEventListener('click', e => {
    if (e.target === thumb) return;
    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const trackH = rect.height;
    const pct = Math.max(0, Math.min(1, clickY / trackH));
    const docTotalH = (viewport.totalDocHeight || 800) * viewport.zoom;
    const stageH = stageRect ? stageRect.height : 600;
    const targetPanY = 30 - pct * Math.max(0, docTotalH - stageH);
    viewport.setPan(viewport.panX, targetPanY, 'left');
    scheduleRedrawTiles();
    redrawAll();
    updateDocScrollbar();
  });
}

// ---- Canvas Right-Click Context Menu ----
function initContextMenu() {
  const menu = $('canvasContextMenu');
  if (!menu) return;

  const hideMenu = () => {
    menu.classList.add('hidden');
  };

  window.addEventListener('click', e => {
    if (!e.target.closest('#canvasContextMenu')) hideMenu();
  });

  window.addEventListener('contextmenu', e => {
    if (!e.target.closest('#stage')) return;
    e.preventDefault();
    // Do not open desktop context menu on touch gestures (2-finger tap is mapped to undo)
    if (e.pointerType === 'touch') return;

    const [wx, wy] = localXY(e, state.drawingPane);
    
    const handle = getSelectionHandleAt(e.clientX - (stageRect ? stageRect.left : 0), e.clientY - (stageRect ? stageRect.top : 0));
    if (!handle) {
      const hit = findObjectAtWorld(wx, wy);
      if (hit) {
        if (hit.type === 'stroke') {
          state.selectedStrokes = [hit.item];
          state.selectedImages = [];
        } else if (hit.type === 'image') {
          state.selectedStrokes = [];
          state.selectedImages = [hit.item];
        }
        setTool('lasso');
        clearWet();
        drawLassoOverlay();
      }
    }

    menu.classList.remove('hidden');
    const menuW = menu.offsetWidth || 180;
    const menuH = menu.offsetHeight || 220;
    const posX = Math.min(window.innerWidth - menuW - 10, Math.max(10, e.clientX));
    const posY = Math.min(window.innerHeight - menuH - 10, Math.max(10, e.clientY));
    menu.style.left = `${posX}px`;
    menu.style.top = `${posY}px`;
  });

  $('ctxMenuCut') && $('ctxMenuCut').addEventListener('click', () => { hideMenu(); cutSelection(); });
  $('ctxMenuCopy') && $('ctxMenuCopy').addEventListener('click', () => { hideMenu(); copySelection(); });
  $('ctxMenuPaste') && $('ctxMenuPaste').addEventListener('click', () => { hideMenu(); pasteClipboard(); });
  $('ctxMenuDuplicate') && $('ctxMenuDuplicate').addEventListener('click', () => { hideMenu(); duplicateSelection(); });
  $('ctxMenuSelectAll') && $('ctxMenuSelectAll').addEventListener('click', () => { hideMenu(); selectAllOnCurrentPage(); });
  $('ctxMenuDelete') && $('ctxMenuDelete').addEventListener('click', () => { hideMenu(); deleteSelection(); });
}

function initSelectionToolbar() {
  $('btnSelCopy') && $('btnSelCopy').addEventListener('click', () => copySelection());
  $('btnSelCut') && $('btnSelCut').addEventListener('click', () => cutSelection());
  $('btnSelDuplicate') && $('btnSelDuplicate').addEventListener('click', () => duplicateSelection());
  $('btnSelDelete') && $('btnSelDelete').addEventListener('click', () => deleteSelection());
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
  let samples = [];
  if (kind === 'rect') {
    const minX = Math.min(wx0, wx1);
    const maxX = Math.max(wx0, wx1);
    const minY = Math.min(wy0, wy1);
    const maxY = Math.max(wy0, wy1);
    const steps = 12;
    // Top edge: (minX, minY) -> (maxX, minY)
    for (let i = 0; i <= steps; i++) samples.push([minX + (maxX - minX) * (i / steps), minY]);
    // Right edge: (maxX, minY) -> (maxX, maxY)
    for (let i = 1; i <= steps; i++) samples.push([maxX, minY + (maxY - minY) * (i / steps)]);
    // Bottom edge: (maxX, maxY) -> (minX, maxY)
    for (let i = 1; i <= steps; i++) samples.push([maxX - (maxX - minX) * (i / steps), maxY]);
    // Left edge: (minX, maxY) -> (minX, minY)
    for (let i = 1; i <= steps; i++) samples.push([minX, maxY - (maxY - minY) * (i / steps)]);
  } else if (kind === 'line') {
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      samples.push([wx0 + (wx1 - wx0) * (i / steps), wy0 + (wy1 - wy0) * (i / steps)]);
    }
  } else { // ellipse: 40-point approximation
    const cx = (wx0 + wx1) / 2, cy = (wy0 + wy1) / 2;
    const rx = Math.abs(wx1 - wx0) / 2, ry = Math.abs(wy1 - wy0) / 2;
    const steps = 40;
    samples = Array.from({ length: steps + 1 }, (_, i) => {
      const a = (i / steps) * Math.PI * 2;
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
function onDown(e) {
  if (e.pointerType === 'touch') {
    if (viewport.isStylusActive || viewport.isPinching || viewport.gestureOccurred || (viewport.activeTouches && viewport.activeTouches.size >= 2)) {
      return;
    }
  }
  if (e.button !== 0 && e.pointerType !== 'pen') return;
  updateStageRect();
  if (e.pointerType !== 'touch') {
    try { wetCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  }
  $('toolbar') && $('toolbar').classList.add('pen-down');
  $('pageNav') && $('pageNav').classList.add('pen-down');
  $('zoomControl') && $('zoomControl').classList.add('pen-down');

  state.drawingPane = paneForEvent(e);
  viewport.activePane = state.drawingPane;
  const [wx, wy] = localXY(e, state.drawingPane);

  // Stylus Hardware Barrel Button (buttons === 32 or secondary button)
  const isStylusBarrel = e.pointerType === 'pen' && (e.buttons === 32 || e.buttons === 2 || e.button === 2);
  if (isStylusBarrel) {
    state.barrelEraserActive = true;
    state.isErasing = true;
    eraseStrokesAt(e);
    return;
  }

  if (state.spacePanActive || state.activeTool === 'pan') {
    if (state.selectedTextSpans && state.selectedTextSpans.length) {
      clearTextSelection();
    }
    commitActiveInlineTextEditor();
    state.handDownPt = [e.clientX, e.clientY];
    state.handStartWorldPt = [wx, wy];
    viewport.isPanning = true;
    viewport.lastPanPt = [e.clientX, e.clientY];
    if (wetCanvas) wetCanvas.classList.add('panning');
    loadTextSpansForPage(state.currentSheet);
    return;
  }

  if (state.activeTool === 'laser') {
    state.isLaserDown = true;
    state.laserPos = [wx, wy];
    addLaserPoint(wx, wy);
    return;
  }

  if (state.activeTool === 'text') {
    commitActiveInlineTextEditor();
    const hit = findTextObjectAtWorld(wx, wy);
    if (hit) {
      openInlineTextEditor(hit, false);
    } else {
      const pageCoord = viewport.worldToPage(wx, wy);
      const newText = {
        id: 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        sheet: pageCoord.sheet,
        x: pageCoord.px,
        y: pageCoord.py,
        text: '',
        fontSize: 16,
        color: '#141724',
        bold: false,
        italic: false,
        deleted: false,
      };
      openInlineTextEditor(newText, true);
    }
    return;
  }

  if (state.activeTool === 'eraser') {
    state.isErasing = true;
    eraseStrokesAt(e);
    return;
  }

  if (state.activeTool === 'lasso') {
    const relX = e.clientX - (stageRect ? stageRect.left : 0);
    const relY = e.clientY - (stageRect ? stageRect.top : 0);
    const handle = getSelectionHandleAt(relX, relY);

    if (handle) {
      state.transformMode = handle.name;
      state.transformStartPt = [wx, wy];
      state.transformInitialBounds = getSelectionBounds();
      state.transformInitialStrokes = (state.selectedStrokes || []).map(s => ({
        id: s.id,
        points: s.points.map(p => ({ ...p }))
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

    // Direct click hit test on a stroke, text object, or image
    const hit = findObjectAtWorld(wx, wy);
    if (hit) {
      if (hit.type === 'stroke') {
        state.selectedStrokes = [hit.item];
        state.selectedImages = [];
        state.selectedTextObjects = [];
      } else if (hit.type === 'image') {
        state.selectedStrokes = [];
        state.selectedImages = [hit.item];
        state.selectedTextObjects = [];
      } else if (hit.type === 'text') {
        state.selectedStrokes = [];
        state.selectedImages = [];
        state.selectedTextObjects = [hit.item];
      }
      state.transformMode = 'move';
      state.transformStartPt = [wx, wy];
      state.transformInitialBounds = getSelectionBounds();
      state.transformInitialStrokes = (state.selectedStrokes || []).map(s => ({
        id: s.id,
        points: s.points.map(p => ({ ...p }))
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
      clearWet();
      drawLassoOverlay();
      return;
    }

    // Click on blank canvas -> deselect and begin freeform lasso
    state.selectedStrokes = [];
    state.selectedImages = [];
    state.selectedTextObjects = [];
    state.lassoPath = [[wx, wy]];
    clearWet();
    drawLassoOverlay();
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

  const pageCoord = viewport.worldToPage(wx, wy);
  state.currentSheet = pageCoord.sheet;

  const isHighlighter = state.activeTool === 'highlighter';
  const actualWidth = isHighlighter ? (state.highlighterWidth || state.baseWidth || 16.0) : (state.penWidth || state.baseWidth || 1.6);
  state.cur = new Ink.Stroke({
    kind: state.activeTool,
    rgb: state.color,
    baseWidth: actualWidth,
    smoothing: false,
  });
  state.streamline = new Ink.Streamline();
  consume(e);
  e.preventDefault();
}

function onMove(e) {
  if (e.pointerType === 'touch') {
    if (viewport.isPinching || viewport.gestureOccurred || (viewport.activeTouches && viewport.activeTouches.size >= 2)) {
      return;
    }
  }
  const [wx, wy] = localXY(e, state.drawingPane);

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
    updateDocScrollbar();

    const activePage = viewport.getActivePageInView(pane);
    if (activePage !== state.leftSheet) {
      state.leftSheet = activePage;
      updatePageUI();
    }
    return;
  }

  if (state.activeTool === 'laser') {
    state.laserPos = [wx, wy];
    if (state.isLaserDown || e.buttons !== 0) {
      if (e.getCoalescedEvents) {
        const co = e.getCoalescedEvents();
        (co.length ? co : [e]).forEach(c => consume(c));
      } else {
        addLaserPoint(wx, wy);
      }
    }
    return;
  }

  if (state.barrelEraserActive || state.activeTool === 'eraser') {
    if (state.isErasing || e.buttons !== 0) {
      eraseStrokesAt(e);
    }
    clearWet();
    const eraserZoom = (state.drawingPane === 'right' && viewport.splitMode) ? viewport.rightZoom : viewport.zoom;
    const radius = 16;
    const [sx, sy] = viewport.worldToScreen(wx, wy, state.drawingPane);
    wctx.save();
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.scale(state.dpr, state.dpr);
    clipToPane(wctx, state.drawingPane);
    wctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
    wctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
    wctx.lineWidth = 1.5;
    wctx.beginPath();
    wctx.arc(sx, sy, radius, 0, Math.PI * 2);
    wctx.fill();
    wctx.stroke();
    wctx.restore();
    return;
  }

  if (state.activeTool === 'lasso') {
    if (!state.transformMode && !state.lassoPath) {
      const relX = e.clientX - (stageRect ? stageRect.left : 0);
      const relY = e.clientY - (stageRect ? stageRect.top : 0);
      const handle = getSelectionHandleAt(relX, relY);
      if (wetCanvas) wetCanvas.style.cursor = handle ? handle.cursor : 'default';
    }

    if (state.transformMode && state.transformStartPt) {
      const dx = wx - state.transformStartPt[0];
      const dy = wy - state.transformStartPt[1];

      if (state.transformMode === 'move') {
        for (const s of (state.selectedStrokes || [])) {
          const init = (state.transformInitialStrokes || []).find(t => t.id === s.id);
          if (init) {
            s.points = init.points.map(p => ({
              x: p.x + dx,
              y: p.y + dy,
              w: p.w,
              p: p.p,
              t: p.t,
            }));
            if (typeof Ink.getPath2D === 'function') {
              s._cachedPath2D = Ink.getPath2D(s);
            }
          }
        }
        for (const img of (state.selectedImages || [])) {
          const init = (state.transformInitialImages || []).find(t => t.id === img.id);
          if (init) {
            img.x = init.x + dx;
            img.y = init.y + dy;
          }
        }
        for (const t of (state.selectedTextObjects || [])) {
          const init = (state.transformInitialTextObjects || []).find(it => it.id === t.id);
          if (init) {
            t.x = init.x + dx;
            t.y = init.y + dy;
          }
        }
      } else {
        const b = state.transformInitialBounds;
        if (b && b.width > 0 && b.height > 0) {
          let newX0 = b.x0, newY0 = b.y0, newX1 = b.x1, newY1 = b.y1;
          const mode = state.transformMode;
          if (mode.includes('e')) newX1 += dx;
          if (mode.includes('w')) newX0 += dx;
          if (mode.includes('s')) newY1 += dy;
          if (mode.includes('n')) newY0 += dy;

          const newW = Math.max(10, newX1 - newX0);
          const newH = Math.max(10, newY1 - newY0);
          const scaleX = newW / b.width;
          const scaleY = newH / b.height;

          for (const s of (state.selectedStrokes || [])) {
            const init = (state.transformInitialStrokes || []).find(t => t.id === s.id);
            if (init) {
              const pl = viewport.getPageLayout(s.sheet);
              s.points = init.points.map(p => {
                const curWx = pl.x + p.x;
                const curWy = pl.y + p.y;
                const normX = (curWx - b.x0) / b.width;
                const normY = (curWy - b.y0) / b.height;
                const scaledWx = newX0 + normX * newW;
                const scaledWy = newY0 + normY * newH;
                return {
                  x: scaledWx - pl.x,
                  y: scaledWy - pl.y,
                  w: p.w * Math.min(scaleX, scaleY),
                  p: p.p,
                  t: p.t,
                };
              });
              if (typeof Ink.getPath2D === 'function') {
                s._cachedPath2D = Ink.getPath2D(s);
              }
            }
          }

          for (const img of (state.selectedImages || [])) {
            const init = (state.transformInitialImages || []).find(t => t.id === img.id);
            if (init) {
              img.width = Math.max(10, init.width * scaleX);
              img.height = Math.max(10, init.height * scaleY);
            }
          }

          for (const t of (state.selectedTextObjects || [])) {
            const init = (state.transformInitialTextObjects || []).find(it => it.id === t.id);
            if (init) {
              const pl = viewport.getPageLayout(t.sheet);
              const curWx = pl.x + init.x;
              const curWy = pl.y + init.y;
              const normX = (curWx - b.x0) / b.width;
              const normY = (curWy - b.y0) / b.height;
              t.x = newX0 + normX * newW - pl.x;
              t.y = newY0 + normY * newH - pl.y;
              t.fontSize = Math.max(8, Math.round(init.fontSize * Math.min(scaleX, scaleY)));
            }
          }
        }
      }

      clearWet();
      redrawAll();
      return;
    }

    if (state.lassoPath) {
      const last = state.lassoPath[state.lassoPath.length - 1];
      if (!last || Math.hypot(wx - last[0], wy - last[1]) > 2) {
        state.lassoPath.push([wx, wy]);
        clearWet();
        drawLassoOverlay();
      }
      return;
    }
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
      wctx.beginPath();
      wctx.moveTo(sx0, sy0);
      wctx.lineTo(sx1, sy1);
      wctx.stroke();
      wctx.restore();
      return;
    }
    drawShapePreview();
    return;
  }

  if (state.activeTool === 'pen' || state.activeTool === 'highlighter') {
    if (!state.cur) return;
    if (e.getCoalescedEvents) {
      const co = e.getCoalescedEvents();
      (co.length ? co : [e]).forEach(c => consume(c));
    } else {
      consume(e);
    }
    e.preventDefault();
  }
}

async function onUp(e) {
  $('toolbar') && $('toolbar').classList.remove('pen-down');
  $('pageNav') && $('pageNav').classList.remove('pen-down');
  $('zoomControl') && $('zoomControl').classList.remove('pen-down');

  if (e.pointerType === 'touch' && (viewport.isPinching || viewport.gestureOccurred || (viewport.activeTouches && viewport.activeTouches.size >= 2))) {
    if (typeof window.cancelPendingTouchStroke === 'function') {
      window.cancelPendingTouchStroke();
    }
    return;
  }

  if (state.activeTool === 'pan') {
    if (state.isSelectingText && state.selectedTextSpans && state.selectedTextSpans.length > 0) {
      state.selectedTextString = state.selectedTextSpans.map(s => s.text).join(' ');
      showTextSelectionPopover();
    }
    state.isSelectingText = false;
    state.handDownPt = null;
    state.handStartWorldPt = null;
  }

  if (viewport.isPanning) {
    viewport.isPanning = false;
    if (wetCanvas) wetCanvas.classList.remove('panning');
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  if (state.activeTool === 'laser') {
    state.isLaserDown = false;
    clearLaser();
    return;
  }

  if (state.barrelEraserActive) {
    state.barrelEraserActive = false;
    state.isErasing = false;
    clearWet();
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  if (state.activeTool === 'eraser') {
    state.isErasing = false;
    clearWet();
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  // Lasso / Transform Commit
  if (state.activeTool === 'lasso') {
    if (wetCanvas) wetCanvas.style.cursor = 'default';
    if (state.transformMode) {
      for (const s of state.selectedStrokes || []) {
        s._cachedPath2D = null;
        s.bbox = (Ink.computeStrokeBbox || computeStrokeBbox)(s.points, s.base_width);
      }
      state.undoStack.push({
        type: 'transform_objects',
        initialStrokes: state.transformInitialStrokes,
        initialImages: state.transformInitialImages,
        initialTextObjects: state.transformInitialTextObjects,
        finalStrokes: (state.selectedStrokes || []).map(s => ({
          id: s.id,
          points: s.points.map(p => ({ ...p }))
        })),
        finalImages: (state.selectedImages || []).map(img => ({
          id: img.id,
          x: img.x,
          y: img.y,
          width: img.width,
          height: img.height,
        })),
        finalTextObjects: (state.selectedTextObjects || []).map(t => ({
          id: t.id,
          x: t.x,
          y: t.y,
          fontSize: t.fontSize || 16,
        })),
      });
      state.redoStack = [];
      state.transformMode = null;
      state.transformStartPt = null;
      state.transformInitialBounds = null;
      state.transformInitialStrokes = null;
      state.transformInitialImages = null;
      state.transformInitialTextObjects = null;
      clearWet();
      redrawAll();
      try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
      return;
    }

    if (state.lassoPath) {
      if (state.lassoPath.length >= 3) {
        const polygon = state.lassoPath;
        let polyMinX = Infinity, polyMinY = Infinity, polyMaxX = -Infinity, polyMaxY = -Infinity;
        for (const pt of polygon) {
          if (pt[0] < polyMinX) polyMinX = pt[0];
          if (pt[1] < polyMinY) polyMinY = pt[1];
          if (pt[0] > polyMaxX) polyMaxX = pt[0];
          if (pt[1] > polyMaxY) polyMaxY = pt[1];
        }

        const matchedStrokes = [];
        const matchedImages = [];
        const matchedTexts = [];

        for (const s of state.strokes) {
          if (s.deleted) continue;
          const pl = viewport.getPageLayout(s.sheet);
          if (!s.bbox && s.points) {
            s.bbox = (Ink.computeStrokeBbox || computeStrokeBbox)(s.points, s.base_width);
          }
          if (s.bbox) {
            const sWorldMinX = pl.x + s.bbox[0];
            const sWorldMinY = pl.y + s.bbox[1];
            const sWorldMaxX = pl.x + s.bbox[2];
            const sWorldMaxY = pl.y + s.bbox[3];
            if (sWorldMaxX < polyMinX || sWorldMinX > polyMaxX || sWorldMaxY < polyMinY || sWorldMinY > polyMaxY) {
              continue;
            }
          }
          const hasPointInside = s.points.some(pt => pointInPolygon(pl.x + pt.x, pl.y + pt.y, polygon));
          if (hasPointInside) matchedStrokes.push(s);
        }

        if (state.images) {
          for (const img of state.images) {
            if (img.deleted) continue;
            const pl = viewport.getPageLayout(img.sheet);
            const imgMinX = pl.x + img.x;
            const imgMinY = pl.y + img.y;
            const imgMaxX = imgMinX + img.width;
            const imgMaxY = imgMinY + img.height;
            if (imgMaxX < polyMinX || imgMinX > polyMaxX || imgMaxY < polyMinY || imgMinY > polyMaxY) {
              continue;
            }
            const cx = imgMinX + img.width / 2;
            const cy = imgMinY + img.height / 2;
            if (pointInPolygon(cx, cy, polygon) || pointInPolygon(imgMinX, imgMinY, polygon)) {
              matchedImages.push(img);
            }
          }
        }

        if (state.textObjects) {
          for (const t of state.textObjects) {
            if (t.deleted) continue;
            const pl = viewport.getPageLayout(t.sheet);
            const tx0 = pl.x + t.x;
            const ty0 = pl.y + t.y;
            const tw = t.width || 120;
            const th = t.height || 32;
            if (pointInPolygon(tx0, ty0, polygon) || pointInPolygon(tx0 + tw / 2, ty0 + th / 2, polygon)) {
              matchedTexts.push(t);
            }
          }
        }

        state.selectedStrokes = matchedStrokes;
        state.selectedImages = matchedImages;
        state.selectedTextObjects = matchedTexts;
      }

      state.lassoPath = null;
      clearWet();
      redrawAll();
      try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
      return;
    }
  }

  // Shape commit
  if ((state.activeTool === 'ruler' || state.activeTool === 'rect' ||
       state.activeTool === 'ellipse') && state.shapeStart && state.shapeEnd) {
    const [ax, ay] = state.shapeStart, [bx, by] = state.shapeEnd;
    clearWet();
    const pageCoord = viewport.worldToPage(ax, ay);
    const pl = viewport.getPageLayout(pageCoord.sheet);
    const localAx = ax - pl.x, localAy = ay - pl.y;
    const localBx = bx - pl.x, localBy = by - pl.y;

    if (Math.hypot(bx - ax, by - ay) > 2) {
      if (state.shapeKind === 'line') {
        const rulerStroke = new Ink.Stroke({ kind: 'pen', rgb: state.color, baseWidth: state.baseWidth });
        rulerStroke.push(localAx, localAy, 0.7, 0);
        rulerStroke.push(localBx, localBy, 0.7, 50);
        const strokeBbox = (Ink.computeStrokeBbox || computeStrokeBbox)(rulerStroke.points, rulerStroke.base_width);
        const finishedStroke = {
          id: rulerStroke.id, kind: rulerStroke.kind, rgb: rulerStroke.rgb,
          base_width: rulerStroke.base_width, points: rulerStroke.points.slice(),
          sheet: pageCoord.sheet, deleted: false,
          bbox: strokeBbox,
          cssColor: rulerStroke.cssColor || `rgb(${rulerStroke.rgb.map(v => Math.round(v * 255)).join(',')})`,
          _cachedPath2D: typeof Ink.getPath2D === 'function' ? Ink.getPath2D(rulerStroke) : null,
        };
        state.strokes.push(finishedStroke);
        state.undoStack.push({ type: 'add', stroke: finishedStroke });
        state.redoStack = [];
        redrawAll();
        const invoke = getInvoke();
        if (invoke) {
          invoke('commit_stroke', {
            sheet: pageCoord.sheet, tool: 'pen', rgb: state.color,
            baseWidth: state.baseWidth,
            samples: [{ x: localAx, y: localAy, pressure: 0.7, t_ms: 0 },
                      { x: localBx, y: localBy, pressure: 0.7, t_ms: 50 }],
          }).catch(err => console.warn('ruler commit failed:', err));
        }
      } else {
        await commitShape(state.shapeKind, localAx, localAy, localBx, localBy);
      }
    }
    state.shapeStart = null; state.shapeEnd = null; state.shapeKind = null;
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    return;
  }

  if (!state.cur) return;

  const finishedStroke = state.cur;
  const pageCoord = viewport.worldToPage(finishedStroke.points[0]?.x || 0, finishedStroke.points[0]?.y || 0);
  const pl = viewport.getPageLayout(pageCoord.sheet);

  // Convert points to sheet-local coordinates
  const localPoints = finishedStroke.points.map(p => ({
    x: p.x - pl.x,
    y: p.y - pl.y,
    w: p.w,
    p: p.p,
    t: p.t,
  }));

  const strokeBbox = (Ink.computeStrokeBbox || computeStrokeBbox)(localPoints, finishedStroke.base_width);
  const strokeRec = {
    id: finishedStroke.id, kind: finishedStroke.kind, rgb: finishedStroke.rgb,
    base_width: finishedStroke.base_width, points: localPoints,
    sheet: pageCoord.sheet, deleted: false,
    cssColor: finishedStroke.cssColor || `rgb(${finishedStroke.rgb.map(v => Math.round(v * 255)).join(',')})`,
    _cachedPath2D: null,
    bbox: strokeBbox,
  };
  if (typeof Ink.getPath2D === 'function') {
    strokeRec._cachedPath2D = Ink.getPath2D(strokeRec);
  }
  state.strokes.push(strokeRec);
  state.undoStack.push({ type: 'add', stroke: strokeRec });
  state.redoStack = [];
  markDirty();

  const invoke = getInvoke();
  if (invoke) {
    try {
      const samplesPayload = localPoints.map(pt => ({
        x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
      }));
      await invoke('commit_stroke', {
        sheet: pageCoord.sheet,
        tool: strokeRec.kind,
        rgb: strokeRec.rgb,
        baseWidth: strokeRec.base_width,
        samples: samplesPayload,
      });
    } catch (err) { console.warn('Failed to commit stroke to Rust core:', err); }
  }

  drawCommittedStroke(strokeRec);
  state.cur = null;

  // Clear dirty damage bounding rect or clear full wet layer
  if (wctx && strokeBbox) {
    wctx.save();
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.scale(state.dpr, state.dpr);
    clipToPane(wctx, state.drawingPane);
    const [sx0, sy0] = viewport.worldToScreen(pl.x + strokeBbox[0] - 8, pl.y + strokeBbox[1] - 8, state.drawingPane);
    const [sx1, sy1] = viewport.worldToScreen(pl.x + strokeBbox[2] + 8, pl.y + strokeBbox[3] + 8, state.drawingPane);
    wctx.clearRect(Math.min(sx0, sx1) - 4, Math.min(sy0, sy1) - 4, Math.abs(sx1 - sx0) + 8, Math.abs(sy1 - sy0) + 8);
    wctx.restore();
  } else {
    clearWet();
  }

  updateStats(e.pointerType);
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
  const el = $('inputStats');
  if (el) {
    el.innerHTML = `
      <div>Pointer: ${escapeHtml(pointerType || 'pen')}</div>
      <div>Samples: ${state.samplesCount}</div>
      <div>Strokes: ${state.strokes.filter(s => !s.deleted).length}</div>
    `;
  }
}

function rgbToHex(rgb) {
  if (!rgb) return '#141724';
  if (typeof rgb === 'string') return rgb.startsWith('#') ? rgb : '#141724';
  const [r, g, b] = rgb.map(v => Math.max(0, Math.min(255, Math.round(v * 255))));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function hexToRgb(hex) {
  if (Array.isArray(hex)) return hex;
  const clean = (hex || '').replace('#', '');
  if (clean.length === 3) {
    return [0, 1, 2].map(i => parseInt(clean[i] + clean[i], 16) / 255);
  }
  if (clean.length >= 6) {
    return [0, 2, 4].map(i => parseInt(clean.substr(i, 2), 16) / 255);
  }
  return [0.08, 0.09, 0.14];
}

function setColor(colorVal, syncUI = true, forTool = null) {
  const tool = forTool || state.activeTool;
  let rgb, hex;
  if (typeof colorVal === 'string') {
    hex = colorVal;
    rgb = hexToRgb(hex);
  } else if (Array.isArray(colorVal)) {
    rgb = colorVal;
    hex = rgbToHex(rgb);
  } else {
    rgb = [0.08, 0.09, 0.14];
    hex = '#141724';
  }

  state.color = rgb;

  if (tool === 'pen') state.penColor = rgb;
  else if (tool === 'highlighter') state.highlighterColor = rgb;
  else if (tool === 'text') state.textColor = hex;
  else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler') state.shapesColor = rgb;

  if (syncUI) {
    if ($('colorPicker')) $('colorPicker').value = hex;

    document.querySelectorAll('.swatch, .settings-color-swatch').forEach(sw => {
      const swColor = sw.getAttribute('data-color');
      if (swColor) {
        sw.classList.toggle('active', swColor.toLowerCase() === hex.toLowerCase());
      }
    });

    document.querySelectorAll('.text-color-swatch').forEach(sw => {
      const swColor = sw.getAttribute('data-color');
      if (swColor) {
        sw.classList.toggle('active', swColor.toLowerCase() === hex.toLowerCase());
      }
    });
  }

  applyColorToSelection(rgb);
  updateToolBadges();
}

// ---- Tool selection ----
function setTool(tool) {
  if (state.activeTool === 'laser' && tool !== 'laser') {
    clearLaser();
  }
  state.activeTool = tool;

  if (tool === 'highlighter') {
    state.baseWidth = state.highlighterWidth || 16.0;
    setColor(state.highlighterColor || [0.99, 0.93, 0.28], true, 'highlighter');
  } else if (tool === 'pen') {
    state.baseWidth = state.penWidth || 1.6;
    setColor(state.penColor || [0.08, 0.09, 0.14], true, 'pen');
  } else if (tool === 'text') {
    setColor(state.textColor || '#141724', true, 'text');
  } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler') {
    state.baseWidth = state.penWidth || 1.6;
    setColor(state.shapesColor || state.penColor || [0.08, 0.09, 0.14], true, tool);
  }

  // Clear active from all dock and toolbar buttons
  document.querySelectorAll('.dock-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));

  const toolBtnMap = {
    pen: 'btnDockPen',
    highlighter: 'btnDockHighlighter',
    eraser: 'btnDockEraser',
    pan: 'btnDockPan',
    lasso: 'btnDockLasso',
    laser: 'btnDockLaser',
    rect: 'btnDockShapes',
    ellipse: 'btnDockShapes',
    ruler: 'btnDockShapes',
    shapes: 'btnDockShapes',
    text: 'btnDockText',
  };

  const btnId = toolBtnMap[tool];
  if (btnId && $(btnId)) {
    $(btnId).classList.add('active');
  }

  // Update legacy buttons if present
  const legacyMap = {
    pen: 'btnPen', highlighter: 'btnHighlighter', eraser: 'btnEraser',
    pan: 'btnPan', lasso: 'btnLasso', ruler: 'btnRuler',
    rect: 'btnRect', ellipse: 'btnEllipse', laser: 'btnLaser',
  };
  if (legacyMap[tool] && $(legacyMap[tool])) {
    $(legacyMap[tool]).classList.add('active');
  }

  // Update radial menu active indicator
  document.querySelectorAll('.radial-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-tool') === tool);
  });

  if (wetCanvas) {
    wetCanvas.className = `tool-${tool}`;
  }

  // Update radial label
  const radialLabel = $('radialLabel');
  if (radialLabel) {
    const titles = {
      pen: 'Pen (P)',
      highlighter: 'Highlighter (M)',
      eraser: 'Eraser (E)',
      pan: 'Hand (H)',
      lasso: 'Lasso (V)',
      laser: 'Laser (L)',
      rect: 'Rectangle (U)',
      ellipse: 'Ellipse (O)',
      ruler: 'Ruler (R)',
      text: 'Text Note (T)',
    };
    radialLabel.textContent = titles[tool] || (tool.charAt(0).toUpperCase() + tool.slice(1));
  }
}

// ---- Undo / Redo ----
function undo() {
  if (!state.undoStack.length) return;
  const op = state.undoStack.pop();
  const invoke = getInvoke();

  if (op.type === 'add') {
    op.stroke.deleted = true;
    if (invoke && op.stroke.id) {
      invoke('delete_stroke', { strokeIdStr: String(op.stroke.id) }).catch(() => {});
    }
    state.redoStack.push(op);
  } else if (op.type === 'erase') {
    for (const s of op.strokes) {
      s.deleted = false;
      if (invoke) {
        const samplesPayload = (s.points || []).map(pt => ({
          x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
        }));
        invoke('commit_stroke', {
          sheet: s.sheet || 0,
          tool: s.kind || 'pen',
          rgb: s.rgb || [0.08, 0.09, 0.14],
          baseWidth: s.base_width || 1.6,
          samples: samplesPayload,
        }).catch(() => {});
      }
    }
    state.redoStack.push(op);
  } else if (op.type === 'delete_objects') {
    for (const s of (op.strokes || [])) {
      s.deleted = false;
      if (invoke) {
        const samplesPayload = (s.points || []).map(pt => ({
          x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
        }));
        invoke('commit_stroke', {
          sheet: s.sheet || 0,
          tool: s.kind || 'pen',
          rgb: s.rgb || [0.08, 0.09, 0.14],
          baseWidth: s.base_width || 1.6,
          samples: samplesPayload,
        }).catch(() => {});
      }
    }
    for (const img of (op.images || [])) img.deleted = false;
    for (const t of (op.textObjects || [])) t.deleted = false;
    state.redoStack.push(op);
  } else if (op.type === 'add_objects') {
    for (const s of (op.strokes || [])) {
      s.deleted = true;
      if (invoke && s.id) {
        invoke('delete_stroke', { strokeIdStr: String(s.id) }).catch(() => {});
      }
    }
    for (const img of (op.images || [])) img.deleted = true;
    for (const t of (op.textObjects || [])) t.deleted = true;
    state.redoStack.push(op);
  } else if (op.type === 'add_image') {
    op.image.deleted = true;
    journalImageMutation('delete', op.image);
    state.redoStack.push(op);
  } else if (op.type === 'add_text_object') {
    op.textObj.deleted = true;
    journalTextMutation('delete', op.textObj);
    state.redoStack.push(op);
  } else if (op.type === 'delete_text_object') {
    op.textObj.deleted = false;
    journalTextMutation('add', op.textObj);
    state.redoStack.push(op);
  } else if (op.type === 'transform_objects') {
    for (const init of (op.initialStrokes || [])) {
      const s = state.strokes.find(st => st.id === init.id);
      if (s) {
        s.points = init.points.map(p => ({ ...p }));
        if (typeof Ink.getPath2D === 'function') s._cachedPath2D = Ink.getPath2D(s);
      }
    }
    for (const init of (op.initialImages || [])) {
      const img = (state.images || []).find(im => im.id === init.id);
      if (img) {
        img.x = init.x; img.y = init.y;
        img.width = init.width; img.height = init.height;
        journalImageMutation('upsert', img);
      }
    }
    for (const init of (op.initialTextObjects || [])) {
      const t = (state.textObjects || []).find(txt => txt.id === init.id);
      if (t) {
        t.x = init.x; t.y = init.y;
        if (init.fontSize) t.fontSize = init.fontSize;
        journalTextMutation('upsert', t);
      }
    }
    state.redoStack.push(op);
  }
  clearWet();
  redrawAll();
  markDirty();
  if (typeof updateUndoRedoUI === 'function') updateUndoRedoUI();
}

function redo() {
  if (!state.redoStack.length) return;
  const op = state.redoStack.pop();
  const invoke = getInvoke();

  if (op.type === 'add') {
    op.stroke.deleted = false;
    if (invoke) {
      const samplesPayload = (op.stroke.points || []).map(pt => ({
        x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
      }));
      invoke('commit_stroke', {
        sheet: op.stroke.sheet || 0,
        tool: op.stroke.kind || 'pen',
        rgb: op.stroke.rgb || [0.08, 0.09, 0.14],
        baseWidth: op.stroke.base_width || 1.6,
        samples: samplesPayload,
      }).catch(() => {});
    }
    state.undoStack.push(op);
  } else if (op.type === 'erase') {
    for (const s of op.strokes) {
      s.deleted = true;
      if (invoke && s.id) {
        invoke('delete_stroke', { strokeIdStr: String(s.id) }).catch(() => {});
      }
    }
    state.undoStack.push(op);
  } else if (op.type === 'delete_objects') {
    for (const s of (op.strokes || [])) {
      s.deleted = true;
      if (invoke && s.id) {
        invoke('delete_stroke', { strokeIdStr: String(s.id) }).catch(() => {});
      }
    }
    for (const img of (op.images || [])) {
      img.deleted = true;
      journalImageMutation('delete', img);
    }
    for (const t of (op.textObjects || [])) {
      t.deleted = true;
      journalTextMutation('delete', t);
    }
    state.undoStack.push(op);
  } else if (op.type === 'add_objects') {
    for (const s of (op.strokes || [])) {
      s.deleted = false;
      if (invoke) {
        const samplesPayload = (s.points || []).map(pt => ({
          x: pt.x, y: pt.y, pressure: pt.p || 0.5, t_ms: pt.t || 0,
        }));
        invoke('commit_stroke', {
          sheet: s.sheet || 0,
          tool: s.kind || 'pen',
          rgb: s.rgb || [0.08, 0.09, 0.14],
          baseWidth: s.base_width || 1.6,
          samples: samplesPayload,
        }).catch(() => {});
      }
    }
    for (const img of (op.images || [])) {
      img.deleted = false;
      journalImageMutation('add', img);
    }
    for (const t of (op.textObjects || [])) {
      t.deleted = false;
      journalTextMutation('add', t);
    }
    state.undoStack.push(op);
  } else if (op.type === 'add_image') {
    op.image.deleted = false;
    journalImageMutation('add', op.image);
    state.undoStack.push(op);
  } else if (op.type === 'add_text_object') {
    op.textObj.deleted = false;
    journalTextMutation('add', op.textObj);
    state.undoStack.push(op);
  } else if (op.type === 'delete_text_object') {
    op.textObj.deleted = true;
    journalTextMutation('delete', op.textObj);
    state.undoStack.push(op);
  } else if (op.type === 'transform_objects') {
    for (const fin of (op.finalStrokes || [])) {
      const s = state.strokes.find(st => st.id === fin.id);
      if (s) {
        s.points = fin.points.map(p => ({ ...p }));
        if (typeof Ink.getPath2D === 'function') s._cachedPath2D = Ink.getPath2D(s);
      }
    }
    for (const fin of (op.finalImages || [])) {
      const img = (state.images || []).find(im => im.id === fin.id);
      if (img) {
        img.x = fin.x; img.y = fin.y;
        img.width = fin.width; img.height = fin.height;
        journalImageMutation('upsert', img);
      }
    }
    for (const fin of (op.finalTextObjects || [])) {
      const t = (state.textObjects || []).find(txt => txt.id === fin.id);
      if (t) {
        t.x = fin.x; t.y = fin.y;
        if (fin.fontSize) t.fontSize = fin.fontSize;
        journalTextMutation('upsert', t);
      }
    }
    state.undoStack.push(op);
  }
  clearWet();
  redrawAll();
  markDirty();
  if (typeof updateUndoRedoUI === 'function') updateUndoRedoUI();
}

function updateUndoRedoUI() {
  const btnUndo = $('btnUndo') || document.querySelector('[data-action="undo"]');
  const btnRedo = $('btnRedo') || document.querySelector('[data-action="redo"]');
  if (btnUndo) {
    btnUndo.disabled = !state.undoStack.length;
    btnUndo.classList.toggle('disabled', !state.undoStack.length);
  }
  if (btnRedo) {
    btnRedo.disabled = !state.redoStack.length;
    btnRedo.classList.toggle('disabled', !state.redoStack.length);
  }
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

// ---- Insert Blank Page with Custom Options ----
async function insertBlankPage(options = {}) {
  const total = state.pageInfos ? state.pageInfos.length : 0;
  let targetIndex = total;

  if (options.position === 'before_current') {
    targetIndex = Math.max(0, state.leftSheet);
  } else if (options.position === 'after_current') {
    targetIndex = Math.min(total, state.leftSheet + 1);
  } else if (options.position === 'document_start') {
    targetIndex = 0;
  } else if (options.position === 'document_end') {
    targetIndex = total;
  } else if (typeof options.targetIndex === 'number') {
    targetIndex = Math.max(0, Math.min(total, options.targetIndex));
  } else {
    // Default: insert after current page
    targetIndex = total > 0 ? Math.min(total, state.leftSheet + 1) : 0;
  }

  let width_pt = 595.0, height_pt = 842.0;
  const curPageInfo = state.pageInfos && state.pageInfos[state.leftSheet];

  if (options.paperSize === 'match_current' && curPageInfo) {
    width_pt = curPageInfo.width_pt || 595.0;
    height_pt = curPageInfo.height_pt || 842.0;
  } else if (options.paperSize === 'letter') {
    width_pt = 612.0; height_pt = 792.0;
  } else if (options.paperSize === 'a3') {
    width_pt = 842.0; height_pt = 1191.0;
  } else if (options.paperSize === 'legal') {
    width_pt = 612.0; height_pt = 1008.0;
  } else if (options.paperSize === 'widescreen') {
    width_pt = 960.0; height_pt = 540.0;
  } else if (options.paperSize === 'custom' && options.customWidth && options.customHeight) {
    width_pt = parseFloat(options.customWidth) || 595.0;
    height_pt = parseFloat(options.customHeight) || 842.0;
  } else if (options.widthPt && options.heightPt) {
    width_pt = options.widthPt;
    height_pt = options.heightPt;
  }

  if (options.orientation === 'landscape' && width_pt < height_pt) {
    const temp = width_pt; width_pt = height_pt; height_pt = temp;
  } else if (options.orientation === 'portrait' && width_pt > height_pt) {
    const temp = width_pt; width_pt = height_pt; height_pt = temp;
  }

  const template = options.template || 'blank';

  const invoke = getInvoke();
  let createdPageInfo = null;
  if (invoke) {
    try {
      createdPageInfo = await invoke('insert_blank_page', {
        index: targetIndex, widthPt: width_pt, heightPt: height_pt,
      });
    } catch (err) {
      console.error('[inkwell] insert_blank_page failed in backend:', err);
      showToast('Failed to insert page: ' + (err.message || err), 'error');
      return;
    }
  }

  if (!createdPageInfo) {
    createdPageInfo = { page_index: targetIndex, width_pt, height_pt };
  }
  createdPageInfo.template = template;

  // If inserted before or in the middle, shift existing stroke & image sheet indices
  if (targetIndex < total) {
    for (const stroke of state.strokes) {
      if (stroke.sheet >= targetIndex) {
        stroke.sheet += 1;
      }
    }
    if (state.images && state.images.length) {
      for (const img of state.images) {
        if (img.sheet >= targetIndex) {
          img.sheet += 1;
        }
      }
    }
    const curTab = state.tabs && state.tabs.find(t => t.id === state.activeTabId);
    if (curTab && curTab.strokes !== state.strokes) {
      for (const stroke of curTab.strokes) {
        if (stroke.sheet >= targetIndex) stroke.sheet += 1;
      }
    }
  }

  // Insert into pageInfos array at targetIndex
  state.pageInfos.splice(targetIndex, 0, createdPageInfo);
  for (let i = 0; i < state.pageInfos.length; i++) {
    state.pageInfos[i].page_index = i;
  }

  const curTab = state.tabs && state.tabs.find(t => t.id === state.activeTabId);
  if (curTab && curTab.pageInfos !== state.pageInfos) {
    curTab.pageInfos = state.pageInfos;
  }

  // CRITICAL: Synchronize viewport continuous scroll layout
  viewport.updateDocumentLayout(state.pageInfos);

  updatePageUI();
  updateDocInfo();
  updateToolBadges();
  clearTileCache();
  goToPage(targetIndex, 'left');
  renderThumbnails();
  scheduleRedrawTiles();
  redrawAll();
  markDirty();
  showToast(`Inserted page ${targetIndex + 1} of ${state.pageInfos.length}`, 'success');
}

function openInsertPageModal() {
  const modal = $('insertPageModal');
  if (!modal) {
    insertBlankPage();
    return;
  }
  const curPage = (state.leftSheet != null) ? (state.leftSheet + 1) : 1;
  const posSelect = $('insertPositionSelect');
  if (posSelect && posSelect.options[0]) {
    posSelect.options[0].textContent = `After Current Page (Page ${curPage})`;
  }
  if (posSelect && posSelect.options[1]) {
    posSelect.options[1].textContent = `Before Current Page (Page ${curPage})`;
  }

  const curPageInfo = state.pageInfos && state.pageInfos[state.leftSheet];
  if (curPageInfo && $('customPageWidth') && $('customPageHeight')) {
    $('customPageWidth').value = Math.round(curPageInfo.width_pt || 595);
    $('customPageHeight').value = Math.round(curPageInfo.height_pt || 842);
  }

  modal.classList.remove('hidden');
}

function closeInsertPageModal() {
  const modal = $('insertPageModal');
  if (modal) modal.classList.add('hidden');
}

function openGoToPageModal() {
  const modal = $('goToPageModal');
  if (!modal) return;
  const total = state.pageInfos ? state.pageInfos.length : 1;
  const cur = (state.leftSheet != null) ? (state.leftSheet + 1) : 1;
  const input = $('goToPageInput');
  const totalDisplay = $('goToPageTotalDisplay');
  if (totalDisplay) totalDisplay.textContent = total;
  if (input) {
    input.max = total;
    input.value = cur;
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 50);
  } else {
    modal.classList.remove('hidden');
  }
}

function closeGoToPageModal() {
  const modal = $('goToPageModal');
  if (modal) modal.classList.add('hidden');
}

function openShortcutsModal() {
  const modal = $('shortcutsModal');
  if (modal) modal.classList.remove('hidden');
}

function closeShortcutsModal() {
  const modal = $('shortcutsModal');
  if (modal) modal.classList.add('hidden');
}

function openSettingsModal(tab = 'tabInking') {
  const modal = $('settingsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  switchSettingsTab(tab);
}

function closeSettingsModal() {
  const modal = $('settingsModal');
  if (modal) modal.classList.add('hidden');
}

function switchSettingsTab(tabId) {
  document.querySelectorAll('.settings-nav-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.settings-tab-panel').forEach(panel => {
    const isTarget = panel.id === tabId;
    panel.classList.toggle('active', isTarget);
    panel.classList.toggle('hidden', !isTarget);
  });
}

// ---- Split View & Sidebar ----
function toggleSplitView() {
  const isSplit = viewport.toggleSplitMode();
  if (isSplit && state.rightSheet === state.leftSheet && state.pageInfos.length > 1) {
    state.rightSheet = Math.min(state.leftSheet + 1, state.pageInfos.length - 1);
  }
  $('stage').classList.toggle('split-view', isSplit);
  $('btnSplit') && $('btnSplit').classList.toggle('active', isSplit);
  $('btnZoomSplit') && $('btnZoomSplit').classList.toggle('active', isSplit);
  $('btnRailSplit') && $('btnRailSplit').classList.toggle('active', isSplit);
  $('splitDivider') && $('splitDivider').classList.toggle('hidden', !isSplit);
  updatePageUI();
  requestAnimationFrame(() => {
    resize();
    viewport.updateStageRect();
    const pi = state.pageInfos[state.leftSheet];
    if (pi) centerPageInPanes(pi);
    scheduleRedrawTiles();
    redrawAll();
    updatePageUI();
  });
}

function toggleSidebar() {
  toggleDrawer('docInfo');
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
  { id: 'new_whiteboard', title: 'New Whiteboard Note', category: 'File', shortcut: 'Ctrl+N', action: () => createBlankWhiteboard() },
  { id: 'open_pdf', title: 'Open PDF Document', category: 'File', shortcut: 'Ctrl+O', action: () => $('btnHeaderOpen') && $('btnHeaderOpen').click() },
  { id: 'save_pdf', title: 'Save PDF Document', category: 'File', shortcut: 'Ctrl+S', action: () => saveDocument(false) },
  { id: 'export_pdf_as', title: 'Export PDF As New Copy...', category: 'File', shortcut: '', action: () => saveDocument(true) },
  { id: 'toggle_split', title: 'Toggle Split View (Dual Pane)', category: 'View', shortcut: '', action: () => toggleSplitView() },
  { id: 'toggle_sidebar', title: 'Toggle Sidebar Panel', category: 'View', shortcut: 'Ctrl+B', action: () => toggleSidebar() },
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
  if (!modal || !input) return;
  modal.classList.remove('hidden');
  input.value = '';
  input.focus();
  renderCommandResults('');
}

function closeCommandPalette() {
  $('cmdPaletteModal') && $('cmdPaletteModal').classList.add('hidden');
}

function renderCommandResults(query) {
  const container = $('cmdPaletteResults');
  if (!container) return;
  const q = query.toLowerCase().trim();
  currentMatches = COMMANDS.filter(c => c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
  selectedCmdIndex = 0;
  container.innerHTML = currentMatches.map((c, i) => `
    <div class="cmd-item ${i === 0 ? 'selected' : ''}" data-index="${i}">
      <span>[${escapeHtml(c.category)}] ${escapeHtml(c.title)}</span>
      <span class="cmd-shortcut">${escapeHtml(c.shortcut)}</span>
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
  if (!menu) return;
  const padding = 120;
  const clampedX = Math.max(padding, Math.min(window.innerWidth - padding, x));
  const clampedY = Math.max(padding, Math.min(window.innerHeight - padding, y));
  menu.style.left = clampedX + 'px';
  menu.style.top = clampedY + 'px';
  menu.classList.remove('hidden');

  // Update active item inside radial menu
  document.querySelectorAll('.radial-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-tool') === state.activeTool);
  });
  const radialLabel = $('radialLabel');
  if (radialLabel) {
    const titles = {
      pen: 'Fountain Pen',
      highlighter: 'Highlighter',
      eraser: 'Precision Eraser',
      pan: 'Hand Tool',
      lasso: 'Lasso Select',
      laser: 'Laser Pointer',
      rect: 'Rectangle Shape',
      text: 'Text Note',
    };
    radialLabel.textContent = titles[state.activeTool] || (state.activeTool.charAt(0).toUpperCase() + state.activeTool.slice(1));
  }

  const centerIcon = menu.querySelector('.radial-center-icon');
  if (centerIcon) {
    const icons = {
      pen: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18z"/><circle cx="11" cy="11" r="2" fill="#ef4444"/></svg>',
      highlighter: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 7-3-3a2.5 2.5 0 0 0-3.5 0L7 12l5 5 8.5-8.5a2.5 2.5 0 0 0 0-3.5z"/></svg>',
      eraser: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2"><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l12.4-12.4a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L9.7 22.3a1 1 0 0 1-1.4 0L7 21z"/><path d="M22 21H7"/></svg>',
      lasso: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-dasharray="3 3" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>',
      pan: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v6"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 0 1 2 2v4a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
    };
    centerIcon.innerHTML = icons[state.activeTool] || icons.pen;
  }
}

function hideRadialMenu() {
  $('radialMenu') && $('radialMenu').classList.add('hidden');
}

// ---- Welcome Mode State Management ----
function setWelcomeState(isWelcome) {
  if (isWelcome) {
    document.body.classList.add('welcome-active');
    if ($('welcomeDropzone')) $('welcomeDropzone').classList.remove('hidden');
    renderRecentFiles();
  } else {
    document.body.classList.remove('welcome-active');
    if ($('welcomeDropzone')) $('welcomeDropzone').classList.add('hidden');
  }
}

// ---- Recent Documents Manager ----
function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const now = Date.now();
  const diffSec = Math.floor((now - timestamp) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function removeRecentFile(path, e) {
  if (e) e.stopPropagation();
  try {
    const raw = localStorage.getItem('inkwell_recent_files');
    let list = raw ? JSON.parse(raw) : [];
    list = list.filter(item => item.path !== path);
    localStorage.setItem('inkwell_recent_files', JSON.stringify(list));
    renderRecentFiles();
  } catch (_) {}
}

function clearRecentFiles() {
  try {
    localStorage.removeItem('inkwell_recent_files');
    renderRecentFiles();
    showToast('Recent documents history cleared', 'info');
  } catch (_) {}
}

function addRecentFile(title, path) {
  if (!path) return;
  try {
    const raw = localStorage.getItem('inkwell_recent_files');
    let list = raw ? JSON.parse(raw) : [];
    list = list.filter(item => item.path !== path);
    list.unshift({ title: title || path.split(/[\/\\]/).pop() || 'Document.pdf', path, time: Date.now() });
    if (list.length > 8) list = list.slice(0, 8);
    localStorage.setItem('inkwell_recent_files', JSON.stringify(list));
    renderRecentFiles();
  } catch (_) {}
}

function renderRecentFiles() {
  const container = $('recentFilesContainer');
  const listEl = $('recentFilesList');
  if (!container || !listEl) return;
  try {
    const raw = localStorage.getItem('inkwell_recent_files');
    const list = raw ? JSON.parse(raw) : [];
    if (!list || !list.length) {
      container.classList.remove('hidden');
      listEl.innerHTML = '<div class="recent-files-empty">No recent documents</div>';
      if ($('btnClearRecents')) $('btnClearRecents').style.display = 'none';
      return;
    }
    if ($('btnClearRecents')) $('btnClearRecents').style.display = 'inline-block';
    container.classList.remove('hidden');
    listEl.innerHTML = list.map(item => `
      <div class="recent-file-item" data-path="${escapeHtml(item.path || '')}" data-title="${escapeHtml(item.title || 'Document.pdf')}">
        <div class="recent-file-icon">📄</div>
        <div class="recent-file-info">
          <div class="recent-file-name-row">
            <span class="recent-file-name">${escapeHtml(item.title || 'Document.pdf')}</span>
            <span class="recent-file-time">${escapeHtml(formatRelativeTime(item.time))}</span>
          </div>
          <div class="recent-file-path" title="${escapeHtml(item.path || '')}">${escapeHtml(item.path || '')}</div>
        </div>
        <button class="recent-file-remove-btn" title="Remove from recent files" aria-label="Remove recent file">✕</button>
      </div>
    `).join('');

    listEl.querySelectorAll('.recent-file-item').forEach(el => {
      const path = el.getAttribute('data-path');
      const title = el.getAttribute('data-title');

      const removeBtn = el.querySelector('.recent-file-remove-btn');
      if (removeBtn) {
        removeBtn.addEventListener('click', (ev) => {
          removeRecentFile(path, ev);
        });
      }

      el.addEventListener('click', async (ev) => {
        if (ev.target.closest('.recent-file-remove-btn')) return;
        if (path) {
          const invoke = getInvoke();
          if (invoke) {
            try {
              const res = await invoke('open_pdf', { pathStr: path });
              if (res && res.page_infos) {
                handlePdfLoadSuccess(title || 'Document.pdf', path, res.page_infos, res.recovered_strokes || 0, res.loaded_strokes || [], res.outline || []);
                showToast(`Opened ${title}`, 'success');
              }
            } catch (err) {
              showToast('Could not open recent file: ' + (err.message || err), 'error');
            }
          }
        }
      });
    });
  } catch (_) {}
}

// ---- Multi-Document Tab Manager ----
state.tabs = [];
state.activeTabId = null;

function createTab(title = 'Untitled.pdf', pathStr = null, pageInfos = []) {
  if (pathStr) {
    addRecentFile(title, pathStr);
  }
  const tabId = 'tab_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const newTab = {
    id: tabId,
    title: title,
    pathStr: pathStr,
    pageInfos: pageInfos || [],
    strokes: [],
    selectedStrokes: [],
    images: [],
    selectedImages: [],
    outline: [],
    undoStack: [],
    redoStack: [],
    bookmarks: [],
    leftSheet: 0,
    rightSheet: 0,
    zoom: 1.0,
    panX: 0,
    panY: 0
  };
  state.tabs.push(newTab);
  setWelcomeState(false);
  renderTabsDOM();
  switchTab(tabId);
  return newTab;
}

async function switchTab(tabId) {
  if (state.activeTabId && tabId !== state.activeTabId) {
    const curTab = state.tabs.find(t => t.id === state.activeTabId);
    if (curTab) {
      curTab.pageInfos = state.pageInfos;
      curTab.strokes = state.strokes;
      curTab.selectedStrokes = state.selectedStrokes;
      curTab.images = state.images || [];
      curTab.selectedImages = state.selectedImages || [];
      curTab.outline = state.outline || [];
      curTab.undoStack = state.undoStack;
      curTab.redoStack = state.redoStack;
      curTab.bookmarks = state.bookmarks || [];
      curTab.leftSheet = state.leftSheet;
      curTab.rightSheet = state.rightSheet;
    }
  }

  const targetTab = state.tabs.find(t => t.id === tabId);
  if (!targetTab) return;

  const invoke = getInvoke();
  if (invoke) {
    try {
      await invoke('switch_document_session', { sessionId: tabId });
    } catch (err) {
      console.warn('[inkwell] switch_document_session warning:', err);
    }
  }

  state.activeTabId = tabId;
  state.pageInfos = targetTab.pageInfos;
  state.strokes = targetTab.strokes;
  state.selectedStrokes = targetTab.selectedStrokes || [];
  state.images = targetTab.images || [];
  state.selectedImages = targetTab.selectedImages || [];
  state.outline = targetTab.outline || [];
  state.undoStack = targetTab.undoStack;
  state.redoStack = targetTab.redoStack;
  state.bookmarks = targetTab.bookmarks || [];
  state.leftSheet = targetTab.leftSheet;
  state.rightSheet = targetTab.rightSheet;

  viewport.updateDocumentLayout(state.pageInfos);

  if ($('activeTabTitle')) $('activeTabTitle').textContent = targetTab.title;
  renderTabsDOM();
  updatePageUI();
  updateDocInfo();
  updateToolBadges();
  renderOutline();
  clearTileCache();
  scheduleRedrawTiles();
  redrawAll();
  updateDocScrollbar();
  renderBookmarks();
  renderLayersDrawer();
}

function promptCloseTab(tabId) {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;

  const hasUnsavedChanges = (tab.strokes && tab.strokes.some(s => !s.deleted)) ||
                            (tab.textObjects && tab.textObjects.some(t => !t.deleted)) ||
                            (tab.images && tab.images.some(img => !img.deleted)) ||
                            (tab.undoStack && tab.undoStack.length > 0);

  if (!hasUnsavedChanges) {
    executeCloseTab(tabId);
    return;
  }

  const modal = $('confirmCloseModal');
  const titleEl = $('confirmCloseTitle');
  const msgEl = $('confirmCloseMsg');
  const btnSave = $('btnConfirmCloseSave');
  const btnDiscard = $('btnConfirmCloseDiscard');
  const btnCancel = $('btnConfirmCloseCancel');

  if (!modal) {
    executeCloseTab(tabId);
    return;
  }

  if (titleEl) titleEl.textContent = `Save changes before closing?`;
  if (msgEl) msgEl.textContent = `Do you want to save changes to "${tab.title || 'Untitled.pdf'}" before closing?`;

  modal.classList.remove('hidden');

  const cleanupListeners = () => {
    modal.classList.add('hidden');
    if (btnSave) btnSave.onclick = null;
    if (btnDiscard) btnDiscard.onclick = null;
    if (btnCancel) btnCancel.onclick = null;
  };

  if (btnCancel) {
    btnCancel.onclick = () => {
      cleanupListeners();
    };
  }

  if (btnDiscard) {
    btnDiscard.onclick = () => {
      cleanupListeners();
      executeCloseTab(tabId);
    };
  }

  if (btnSave) {
    btnSave.onclick = async () => {
      cleanupListeners();
      if (state.activeTabId !== tabId) {
        switchTab(tabId);
      }
      await saveDocument(false);
      executeCloseTab(tabId);
    };
  }
}

function executeCloseTab(tabId) {
  const invoke = getInvoke();
  if (invoke) {
    try {
      invoke('close_document_session', { sessionId: tabId });
    } catch (err) {
      console.warn('[inkwell] close_document_session warning:', err);
    }
  }

  const idx = state.tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  state.tabs.splice(idx, 1);

  if (state.tabs.length === 0) {
    // All documents closed: reset state and show clean welcome / open screen
    state.activeTabId = null;
    state.pageInfos = [];
    state.strokes = [];
    state.textObjects = [];
    state.images = [];
    state.selectedStrokes = [];
    state.selectedTextObjects = [];
    state.selectedImages = [];
    state.undoStack = [];
    state.redoStack = [];
    state.leftSheet = 0;
    state.rightSheet = 0;
    state.outline = [];
    state.bookmarks = [];

    if (dctx && dryCanvas) dctx.clearRect(0, 0, dryCanvas.width, dryCanvas.height);
    if (wctx && wetCanvas) wctx.clearRect(0, 0, wetCanvas.width, wetCanvas.height);
    if (tctx && tilesCanvas) tctx.clearRect(0, 0, tilesCanvas.width, tilesCanvas.height);

    viewport.updateDocumentLayout([]);
    renderTabsDOM();
    updatePageUI();
    updateDocInfo();
    renderOutline();
    renderBookmarks();

    setWelcomeState(true);
    if ($('activeTabTitle')) $('activeTabTitle').textContent = 'InkWell';
    showToast('Document closed', 'info');
  } else {
    if (state.activeTabId === tabId) {
      const nextTab = state.tabs[Math.max(0, idx - 1)];
      switchTab(nextTab.id);
    } else {
      renderTabsDOM();
    }
  }
}

function closeTab(tabId, e) {
  if (e) e.stopPropagation();
  promptCloseTab(tabId);
}

// ---- Page Management Suite ----
async function deleteCurrentPage(index) {
  if (index == null) index = state.leftSheet;
  if (!state.pageInfos || state.pageInfos.length <= 1) {
    showToast('Cannot delete the only page in the document.', 'warning');
    return;
  }
  const pageNum = index + 1;
  const invoke = getInvoke();
  if (invoke) {
    try {
      await invoke('delete_page', { index });
    } catch (err) {
      console.error('[inkwell] delete_page failed:', err);
      showToast('Failed to delete page: ' + (err.message || err), 'error');
      return;
    }
  }

  // Remove strokes & images on deleted page, shift subsequent sheets down by 1
  state.strokes = state.strokes.filter(s => s.sheet !== index);
  for (const s of state.strokes) {
    if (s.sheet > index) s.sheet -= 1;
  }
  if (state.images) {
    state.images = state.images.filter(img => img.sheet !== index);
    for (const img of state.images) {
      if (img.sheet > index) img.sheet -= 1;
    }
  }

  state.pageInfos.splice(index, 1);
  for (let i = 0; i < state.pageInfos.length; i++) {
    state.pageInfos[i].page_index = i;
  }

  const curTab = state.tabs && state.tabs.find(t => t.id === state.activeTabId);
  if (curTab) {
    curTab.pageInfos = state.pageInfos;
    curTab.strokes = state.strokes;
    curTab.images = state.images;
  }

  viewport.updateDocumentLayout(state.pageInfos);
  const targetSheet = Math.min(index, state.pageInfos.length - 1);
  state.leftSheet = targetSheet;

  clearTileCache();
  updatePageUI();
  updateDocInfo();
  updateToolBadges();
  goToPage(targetSheet, 'left');
  renderThumbnails();
  scheduleRedrawTiles();
  redrawAll();
  markDirty();
  showToast(`Deleted Page ${pageNum}`, 'info');
}

async function duplicateCurrentPage(index) {
  if (index == null) index = state.leftSheet;
  const targetIdx = index + 1;
  const invoke = getInvoke();
  let newPageInfo = null;
  if (invoke) {
    try {
      newPageInfo = await invoke('duplicate_page', { index });
    } catch (err) {
      console.error('[inkwell] duplicate_page failed:', err);
      showToast('Failed to duplicate page: ' + (err.message || err), 'error');
      return;
    }
  }

  const src = state.pageInfos[index];
  const srcTemplate = (src && src.template) ? src.template : 'blank';
  if (newPageInfo) {
    newPageInfo.template = srcTemplate;
  } else {
    newPageInfo = {
      page_index: targetIdx,
      width_pt: src ? src.width_pt : 595.0,
      height_pt: src ? src.height_pt : 842.0,
      template: srcTemplate,
    };
  }

  // Duplicate strokes from page `index` to page `targetIdx`
  const clonedStrokes = [];
  for (const s of state.strokes) {
    if (s.sheet === index) {
      clonedStrokes.push({
        ...s,
        id: 'strk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        sheet: targetIdx,
        points: s.points.map(p => ({ ...p })),
      });
    } else if (s.sheet >= targetIdx) {
      s.sheet += 1;
    }
  }
  state.strokes.push(...clonedStrokes);

  state.pageInfos.splice(targetIdx, 0, newPageInfo);
  for (let i = 0; i < state.pageInfos.length; i++) {
    state.pageInfos[i].page_index = i;
  }

  const curTab = state.tabs && state.tabs.find(t => t.id === state.activeTabId);
  if (curTab) {
    curTab.pageInfos = state.pageInfos;
    curTab.strokes = state.strokes;
  }

  viewport.updateDocumentLayout(state.pageInfos);
  clearTileCache();
  updatePageUI();
  updateDocInfo();
  updateToolBadges();
  goToPage(targetIdx, 'left');
  renderThumbnails();
  scheduleRedrawTiles();
  redrawAll();
  markDirty();
  showToast(`Duplicated Page ${index + 1} to Page ${targetIdx + 1}`, 'success');
}

async function rotateCurrentPage(index, clockwise = true) {
  if (index == null) index = state.leftSheet;
  const invoke = getInvoke();
  let updatedInfo = null;
  if (invoke) {
    try {
      updatedInfo = await invoke('rotate_page', { index, clockwise });
    } catch (err) {
      console.error('[inkwell] rotate_page failed:', err);
      showToast('Failed to rotate page: ' + (err.message || err), 'error');
      return;
    }
  }

  const pi = state.pageInfos[index];
  if (pi) {
    const oldW = pi.width_pt;
    const oldH = pi.height_pt;
    if (updatedInfo) {
      pi.width_pt = updatedInfo.width_pt;
      pi.height_pt = updatedInfo.height_pt;
    } else {
      pi.width_pt = oldH;
      pi.height_pt = oldW;
    }

    // Rotate existing strokes on this sheet to match new page orientation
    for (const s of state.strokes) {
      if (s.sheet === index && s.points) {
        for (const p of s.points) {
          const px = p.x;
          const py = p.y;
          if (clockwise) {
            p.x = oldH - py;
            p.y = px;
          } else {
            p.x = py;
            p.y = oldW - px;
          }
        }
        s._cachedPath2D = null;
      }
    }
  }

  viewport.updateDocumentLayout(state.pageInfos);
  clearTileCache();
  updatePageUI();
  updateDocInfo();
  goToPage(index, 'left');
  renderThumbnails();
  scheduleRedrawTiles();
  redrawAll();
  markDirty();
  showToast(`Rotated Page ${index + 1} ${clockwise ? '90° Clockwise' : '90° Counter-Clockwise'}`, 'info');
}

async function reorderPage(fromIndex, toIndex) {
  if (fromIndex === toIndex || !state.pageInfos) return;
  const total = state.pageInfos.length;
  if (fromIndex < 0 || fromIndex >= total || toIndex < 0 || toIndex >= total) return;

  const invoke = getInvoke();
  if (invoke) {
    try {
      await invoke('reorder_page', { fromIndex, toIndex });
    } catch (err) {
      console.error('[inkwell] reorder_page failed:', err);
      showToast('Failed to reorder page: ' + (err.message || err), 'error');
      return;
    }
  }

  const [movedPage] = state.pageInfos.splice(fromIndex, 1);
  state.pageInfos.splice(toIndex, 0, movedPage);
  for (let i = 0; i < state.pageInfos.length; i++) {
    state.pageInfos[i].page_index = i;
  }

  for (const s of state.strokes) {
    if (s.sheet === fromIndex) {
      s.sheet = toIndex;
    } else if (fromIndex < toIndex && s.sheet > fromIndex && s.sheet <= toIndex) {
      s.sheet -= 1;
    } else if (fromIndex > toIndex && s.sheet >= toIndex && s.sheet < fromIndex) {
      s.sheet += 1;
    }
  }

  if (state.images) {
    for (const img of state.images) {
      if (img.sheet === fromIndex) {
        img.sheet = toIndex;
      } else if (fromIndex < toIndex && img.sheet > fromIndex && img.sheet <= toIndex) {
        img.sheet -= 1;
      } else if (fromIndex > toIndex && img.sheet >= toIndex && img.sheet < fromIndex) {
        img.sheet += 1;
      }
    }
  }

  const curTab = state.tabs && state.tabs.find(t => t.id === state.activeTabId);
  if (curTab) {
    curTab.pageInfos = state.pageInfos;
    curTab.strokes = state.strokes;
    curTab.images = state.images;
  }

  viewport.updateDocumentLayout(state.pageInfos);
  clearTileCache();
  updatePageUI();
  updateDocInfo();
  goToPage(toIndex, 'left');
  renderThumbnails();
  scheduleRedrawTiles();
  redrawAll();
  markDirty();
  showToast(`Moved Page ${fromIndex + 1} to Page ${toIndex + 1}`, 'info');
}

function renderTabsDOM() {
  const container = $('tabList');
  if (!container) return;
  container.innerHTML = state.tabs.map(t => `
    <div class="doc-tab ${t.id === state.activeTabId ? 'active' : ''}" data-tab-id="${t.id}">
      <svg class="tab-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="tab-title">${escapeHtml(t.title)}</span>
      <button class="tab-close" data-close-id="${t.id}" title="Close document">✕</button>
    </div>
  `).join('');

  container.querySelectorAll('.doc-tab').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('tab-close')) return;
      const tid = el.getAttribute('data-tab-id');
      if (tid) switchTab(tid);
    });
  });

  container.querySelectorAll('.tab-close').forEach(btn => {
    btn.addEventListener('click', e => {
      const cid = btn.getAttribute('data-close-id');
      if (cid) closeTab(cid, e);
    });
  });
}

// ---- Search in Document ----
async function executeSearch(query) {
  const container = $('drawerSearchResults');
  if (!container) return;
  const q = (query || ($('drawerSearchInput') ? $('drawerSearchInput').value : '')).trim();
  if (!q) {
    container.innerHTML = '<div class="info-item">Enter a term to search this document.</div>';
    return;
  }
  container.innerHTML = '<div class="info-item">Searching document...</div>';
  const invoke = getInvoke();
  if (!invoke) {
    container.innerHTML = '<div class="info-item">Search is available in the desktop app.</div>';
    return;
  }
  try {
    const results = await invoke('search_pdf', { query: q });
    if (!results || !results.length) {
      container.innerHTML = `<div class="info-item">No matches found for "${escapeHtml(q)}".</div>`;
      return;
    }
    container.innerHTML = results.map(r => `
      <div class="search-result-card" data-page="${r.page_index}">
        <div class="search-result-header">
          <span class="search-page-badge">Page ${r.page_index + 1}</span>
          <span class="search-match-count">${r.match_count} match${r.match_count > 1 ? 'es' : ''}</span>
        </div>
        <div class="search-snippet">${escapeHtml(r.snippet)}</div>
      </div>
    `).join('');

    container.querySelectorAll('.search-result-card').forEach(el => {
      el.addEventListener('click', () => {
        const p = parseInt(el.getAttribute('data-page'), 10);
        if (!isNaN(p)) goToPage(p, 'left');
      });
    });
  } catch (err) {
    console.error('[inkwell] search error:', err);
    container.innerHTML = `<div class="info-item error">Search failed: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

// ---- Bookmarks in Document ----
function addBookmarkForCurrentPage() {
  const curPage = state.leftSheet;
  if (!Array.isArray(state.bookmarks)) state.bookmarks = [];
  if (state.bookmarks.some(b => b.page === curPage)) {
    showToast(`Page ${curPage + 1} is already bookmarked`, 'info');
    return;
  }
  state.bookmarks.push({
    id: 'bm_' + Date.now(),
    page: curPage,
    label: `Page ${curPage + 1}`,
    createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  });
  renderBookmarks();
  showToast(`Bookmarked Page ${curPage + 1}`, 'success');
}

function removeBookmark(id) {
  state.bookmarks = state.bookmarks.filter(b => b.id !== id);
  renderBookmarks();
}

function renderBookmarks() {
  const container = $('bookmarksList');
  if (!container) return;
  if (!state.bookmarks || !state.bookmarks.length) {
    container.innerHTML = `
      <div class="drawer-empty-state">
        <div class="empty-state-icon">📌</div>
        <div class="empty-state-title">No Bookmarks Added</div>
        <div class="empty-state-desc">Click "Bookmark Current Page" above to quickly save key sections of this document.</div>
      </div>
    `;
    return;
  }
  container.innerHTML = state.bookmarks.map(b => `
    <div class="bookmark-card" data-page="${b.page}">
      <div class="bookmark-info">
        <span class="bookmark-title">📌 ${escapeHtml(b.label)}</span>
        <span class="bookmark-meta">Page ${b.page + 1} • ${escapeHtml(b.createdAt)}</span>
      </div>
      <button class="bookmark-delete-btn" data-bm-id="${b.id}" title="Remove bookmark" aria-label="Remove bookmark">✕</button>
    </div>
  `).join('');

  container.querySelectorAll('.bookmark-card').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('bookmark-delete-btn')) return;
      const p = parseInt(el.getAttribute('data-page'), 10);
      if (!isNaN(p)) goToPage(p, 'left');
    });
  });

  container.querySelectorAll('.bookmark-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const bid = btn.getAttribute('data-bm-id');
      if (bid) removeBookmark(bid);
    });
  });
}

// ---- Layers Drawer & Ink Visibility ----
function toggleInkVisibility() {
  state.inkVisible = !state.inkVisible;
  if (dryCanvas) dryCanvas.style.display = state.inkVisible ? 'block' : 'none';
  if (wetCanvas) wetCanvas.style.opacity = state.inkVisible ? '1' : '0';
  renderLayersDrawer();
  showToast(state.inkVisible ? 'Ink Layer visible' : 'Ink Layer hidden', 'info');
}

function renderLayersDrawer() {
  const container = $('layersList');
  if (!container) return;
  const strokeCount = state.strokes ? state.strokes.filter(s => !s.deleted).length : 0;
  container.innerHTML = `
    <div class="layer-control-row ${state.inkVisible ? 'active' : ''}">
      <div class="layer-info">
        <span class="layer-name">🖊️ Vector Ink Layer</span>
        <span class="layer-count">${strokeCount} vector stroke${strokeCount !== 1 ? 's' : ''} • Real-time</span>
      </div>
      <button id="btnToggleInkLayer" class="layer-visibility-btn" title="${state.inkVisible ? 'Hide ink layer' : 'Show ink layer'}" aria-label="Toggle ink visibility">
        ${state.inkVisible ? '👁️' : '👁️‍🗨️'}
      </button>
    </div>
    <div class="layer-control-row active" style="margin-top:8px;">
      <div class="layer-info">
        <span class="layer-name">📄 PDF Vector Underlay</span>
        <span class="layer-count">On-demand LOD tile renderer</span>
      </div>
      <span style="font-size:11px; color:#10b981; font-weight:600; padding:4px 8px; background:rgba(16,185,129,0.1); border-radius:6px;">Base</span>
    </div>
  `;
  const toggleBtn = $('btnToggleInkLayer');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', toggleInkVisibility);
  }
}

// ---- Navigation Drawer (secondary panel) ----
const DRAWER_VIEWS = {
  thumbnails: { viewId: 'drawerThumbnails', title: 'Thumbnails' },
  outline:    { viewId: 'drawerOutline',    title: 'Document Outline' },
  search:     { viewId: 'drawerSearch',     title: 'Search' },
  bookmarks:  { viewId: 'drawerBookmarks',  title: 'Bookmarks' },
  layers:     { viewId: 'drawerLayers',     title: 'Ink Layers' },
  docInfo:    { viewId: 'drawerDocInfo',    title: 'Document Info' },
};

const RAIL_BTN_MAP = {
  thumbnails: 'btnRailThumbnails',
  outline:    'btnRailOutline',
  search:     'btnRailSearch',
  bookmarks:  'btnRailBookmarks',
  layers:     'btnRailLayers',
  docInfo:    'btnRailDocInfo',
};

function onDrawerLayoutChange() {
  updateStageRect();
  resize();
  if (viewport && viewport.updateStageRect) viewport.updateStageRect();
  const pi = state.pageInfos[state.leftSheet];
  if (pi) recenterPanesOnly(pi);
  scheduleRedrawTiles();
  redrawAll();
}

function toggleDrawer(name) {
  const drawer = $('navDrawer');
  const view = DRAWER_VIEWS[name];
  if (!drawer || !view) return;

  const isOpen = state.activeDrawer === name && !drawer.classList.contains('hidden');
  if (isOpen) {
    drawer.classList.add('hidden');
    state.activeDrawer = null;
  } else {
    drawer.classList.remove('hidden');
    state.activeDrawer = name;
    document.querySelectorAll('.drawer-content').forEach(el => el.classList.add('hidden'));
    $(view.viewId) && $(view.viewId).classList.remove('hidden');
    if ($('drawerTitle')) $('drawerTitle').textContent = view.title;
    if (name === 'thumbnails') renderThumbnails();
    if (name === 'outline') renderOutline();
    if (name === 'docInfo') updateDocInfo();
    if (name === 'bookmarks') renderBookmarks();
    if (name === 'layers') renderLayersDrawer();
  }
  updateRailButtonsUI();
  onDrawerLayoutChange();
}

function updateRailButtonsUI() {
  Object.keys(RAIL_BTN_MAP).forEach(viewName => {
    const btn = $(RAIL_BTN_MAP[viewName]);
    if (btn) btn.classList.toggle('active', state.activeDrawer === viewName);
  });
  const splitBtn = $('btnRailSplit');
  if (splitBtn) splitBtn.classList.toggle('active', !!(viewport && viewport.splitMode));
  const zoomSplitBtn = $('btnZoomSplit');
  if (zoomSplitBtn) zoomSplitBtn.classList.toggle('active', !!(viewport && viewport.splitMode));
}

// ---- Text Spans & Drawboard-Style Text Selection ----
async function loadTextSpansForPage(sheet) {
  if (state.pageTextSpans[sheet]) return state.pageTextSpans[sheet];
  const invoke = getInvoke();
  if (!invoke) return [];
  try {
    const spans = await invoke('get_page_text_spans', { pageIndex: sheet });
    state.pageTextSpans[sheet] = spans || [];
    return state.pageTextSpans[sheet];
  } catch (err) {
    console.warn('[inkwell] get_page_text_spans failed for page', sheet, err);
    state.pageTextSpans[sheet] = [];
    return [];
  }
}

function clearTextSelection() {
  state.selectedTextSpans = [];
  state.selectedTextString = '';
  state.isSelectingText = false;
  const popover = $('textSelectionPopover');
  if (popover) popover.classList.add('hidden');
  clearWet();
}

function drawTextSelectionHighlights() {
  if (!wctx || !wetCanvas || !state.selectedTextSpans || !state.selectedTextSpans.length) return;
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.scale(state.dpr, state.dpr);

  for (const span of state.selectedTextSpans) {
    const pl = viewport.getPageLayout(span.page_index);
    const [sx0, sy0] = viewport.worldToScreen(pl.x + span.rect[0], pl.y + span.rect[1], state.drawingPane || 'left');
    const [sx1, sy1] = viewport.worldToScreen(pl.x + span.rect[2], pl.y + span.rect[3], state.drawingPane || 'left');

    const w = sx1 - sx0;
    const h = sy1 - sy0;

    wctx.fillStyle = 'rgba(99, 102, 241, 0.3)';
    wctx.strokeStyle = 'rgba(99, 102, 241, 0.7)';
    wctx.lineWidth = 1;
    wctx.beginPath();
    if (typeof wctx.roundRect === 'function') {
      wctx.roundRect(sx0 - 1, sy0 - 1, w + 2, h + 2, 3);
    } else {
      wctx.rect(sx0 - 1, sy0 - 1, w + 2, h + 2);
    }
    wctx.fill();
    wctx.stroke();
  }
  wctx.restore();
}

function showTextSelectionPopover() {
  const popover = $('textSelectionPopover');
  if (!popover || !state.selectedTextSpans || !state.selectedTextSpans.length) return;

  let minSx = Infinity, minSy = Infinity, maxSx = -Infinity;
  for (const span of state.selectedTextSpans) {
    const pl = viewport.getPageLayout(span.page_index);
    const [sx0, sy0] = viewport.worldToScreen(pl.x + span.rect[0], pl.y + span.rect[1], state.drawingPane || 'left');
    const [sx1] = viewport.worldToScreen(pl.x + span.rect[2], pl.y + span.rect[3], state.drawingPane || 'left');
    minSx = Math.min(minSx, sx0);
    maxSx = Math.max(maxSx, sx1);
    minSy = Math.min(minSy, sy0);
  }

  const midSx = (minSx + maxSx) / 2;
  const popoverX = Math.max(120, Math.min(window.innerWidth - 140, midSx));
  const popoverY = Math.max(70, minSy - 12);

  popover.style.left = `${popoverX}px`;
  popover.style.top = `${popoverY}px`;
  popover.classList.remove('hidden');
}

function initTextSelectionActions() {
  const btnCopy = $('btnTextCopy');
  const btnHighlight = $('btnTextHighlight');
  const btnUnderline = $('btnTextUnderline');
  const btnStrike = $('btnTextStrikethrough');
  const btnSearch = $('btnTextSearch');

  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      if (state.selectedTextString) {
        navigator.clipboard.writeText(state.selectedTextString);
        showToast('Text copied to clipboard', 'success');
      }
      clearTextSelection();
    });
  }

  if (btnHighlight) {
    btnHighlight.addEventListener('click', () => {
      if (!state.selectedTextSpans || !state.selectedTextSpans.length) return;
      const invoke = getInvoke();
      const newStrokes = [];

      for (const span of state.selectedTextSpans) {
        const sheet = span.page_index;
        const [x0, y0, x1, y1] = span.rect;
        const midY = (y0 + y1) / 2;
        const h = Math.max(10, y1 - y0);

        const stroke = {
          id: 'hl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          kind: 'highlighter',
          sheet,
          rgb: [0.99, 0.93, 0.28], // fluorescent yellow
          base_width: h,
          points: [
            { x: x0, y: midY, p: 0.5, w: h, t: 0 },
            { x: x1, y: midY, p: 0.5, w: h, t: 10 }
          ],
          deleted: false,
        };

        if (typeof Ink.getPath2D === 'function') {
          stroke._cachedPath2D = Ink.getPath2D(stroke);
        }

        state.strokes.push(stroke);
        newStrokes.push(stroke);

        if (invoke) {
          invoke('commit_stroke', {
            sheet,
            tool: 'highlighter',
            rgb: stroke.rgb,
            baseWidth: h,
            samples: stroke.points.map(p => ({ x: p.x, y: p.y, pressure: 0.5, t_ms: p.t })),
          }).catch(err => console.warn('highlight commit failed:', err));
        }
      }

      state.undoStack.push({ type: 'add_objects', strokes: newStrokes, images: [] });
      state.redoStack = [];
      clearTextSelection();
      redrawAll();
      showToast('Text highlighted', 'success');
    });
  }

  if (btnUnderline) {
    btnUnderline.addEventListener('click', () => {
      if (!state.selectedTextSpans || !state.selectedTextSpans.length) return;
      const invoke = getInvoke();
      const newStrokes = [];

      for (const span of state.selectedTextSpans) {
        const sheet = span.page_index;
        const [x0, , x1, y1] = span.rect;
        const underY = y1 + 1.5;

        const stroke = {
          id: 'ul_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          kind: 'pen',
          sheet,
          rgb: state.color || [0.86, 0.15, 0.15],
          base_width: 2.0,
          points: [
            { x: x0, y: underY, p: 0.5, w: 2.0, t: 0 },
            { x: x1, y: underY, p: 0.5, w: 2.0, t: 10 }
          ],
          deleted: false,
        };

        if (typeof Ink.getPath2D === 'function') {
          stroke._cachedPath2D = Ink.getPath2D(stroke);
        }

        state.strokes.push(stroke);
        newStrokes.push(stroke);

        if (invoke) {
          invoke('commit_stroke', {
            sheet,
            tool: 'pen',
            rgb: stroke.rgb,
            baseWidth: 2.0,
            samples: stroke.points.map(p => ({ x: p.x, y: p.y, pressure: 0.5, t_ms: p.t })),
          }).catch(err => console.warn('underline commit failed:', err));
        }
      }

      state.undoStack.push({ type: 'add_objects', strokes: newStrokes, images: [] });
      state.redoStack = [];
      clearTextSelection();
      redrawAll();
      showToast('Text underlined', 'success');
    });
  }

  if (btnStrike) {
    btnStrike.addEventListener('click', () => {
      if (!state.selectedTextSpans || !state.selectedTextSpans.length) return;
      const invoke = getInvoke();
      const newStrokes = [];

      for (const span of state.selectedTextSpans) {
        const sheet = span.page_index;
        const [x0, y0, x1, y1] = span.rect;
        const midY = (y0 + y1) / 2;

        const stroke = {
          id: 'st_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          kind: 'pen',
          sheet,
          rgb: state.color || [0.86, 0.15, 0.15],
          base_width: 2.0,
          points: [
            { x: x0, y: midY, p: 0.5, w: 2.0, t: 0 },
            { x: x1, y: midY, p: 0.5, w: 2.0, t: 10 }
          ],
          deleted: false,
        };

        if (typeof Ink.getPath2D === 'function') {
          stroke._cachedPath2D = Ink.getPath2D(stroke);
        }

        state.strokes.push(stroke);
        newStrokes.push(stroke);

        if (invoke) {
          invoke('commit_stroke', {
            sheet,
            tool: 'pen',
            rgb: stroke.rgb,
            baseWidth: 2.0,
            samples: stroke.points.map(p => ({ x: p.x, y: p.y, pressure: 0.5, t_ms: p.t })),
          }).catch(err => console.warn('strikethrough commit failed:', err));
        }
      }

      state.undoStack.push({ type: 'add_objects', strokes: newStrokes, images: [] });
      state.redoStack = [];
      clearTextSelection();
      redrawAll();
      showToast('Strikethrough applied', 'success');
    });
  }

  if (btnSearch) {
    btnSearch.addEventListener('click', () => {
      if (state.selectedTextString) {
        openDrawer('search');
        const input = $('drawerSearchInput');
        if (input) {
          input.value = state.selectedTextString;
          input.dispatchEvent(new Event('input'));
        }
      }
      clearTextSelection();
    });
  }
}

// ---- Direct In-Place Text Tool ----
function findTextObjectAtWorld(wx, wy) {
  if (!state.textObjects || !state.textObjects.length) return null;
  const pageCoord = viewport.worldToPage(wx, wy);
  const targetSheet = pageCoord.sheet;

  for (let i = state.textObjects.length - 1; i >= 0; i--) {
    const t = state.textObjects[i];
    if (t.deleted || t.sheet !== targetSheet) continue;
    const w = t.width || 120;
    const h = t.height || 32;
    if (pageCoord.px >= t.x && pageCoord.px <= t.x + w && pageCoord.py >= t.y && pageCoord.py <= t.y + h) {
      return t;
    }
  }
  return null;
}

function renderTextObjectToDataUrl(t) {
  const canvas = document.createElement('canvas');
  const dpr = 2;
  const fontSize = t.fontSize || 16;
  const lines = (t.text || '').split('\n');
  const lineHeight = fontSize * 1.35;
  const fontStyle = `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${fontSize}px Inter, system-ui, -apple-system, sans-serif`;

  const ctx = canvas.getContext('2d');
  ctx.font = fontStyle;
  let maxW = 0;
  lines.forEach(l => {
    const w = ctx.measureText(l).width;
    if (w > maxW) maxW = w;
  });
  const width = Math.max(10, Math.ceil(maxW + 8));
  const height = Math.max(10, Math.ceil(lines.length * lineHeight + 8));

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.font = fontStyle;
  ctx.fillStyle = t.color || '#141724';
  ctx.textBaseline = 'top';

  lines.forEach((l, idx) => {
    ctx.fillText(l, 4, 4 + idx * lineHeight);
  });

  return {
    sheet: t.sheet || 0,
    x: t.x,
    y: t.y,
    width,
    height,
    data_url: canvas.toDataURL('image/png'),
  };
}

function openInlineTextEditor(textObj, isNew = false) {
  const overlay = $('inlineTextOverlay');
  const input = $('inlineTextInput');
  const lblSize = $('lblTextSize');
  if (!overlay || !input) return;

  state.activeTextEditorObj = textObj;

  const pl = viewport.getPageLayout(textObj.sheet);
  const [sx, sy] = viewport.worldToScreen(pl.x + textObj.x, pl.y + textObj.y, state.drawingPane || 'left');

  overlay.style.left = `${Math.max(10, Math.min(window.innerWidth - 240, sx))}px`;
  overlay.style.top = `${Math.max(60, Math.min(window.innerHeight - 100, sy))}px`;
  overlay.classList.remove('hidden');

  input.value = textObj.text || '';
  input.style.fontSize = `${textObj.fontSize || 16}px`;
  input.style.fontWeight = textObj.bold ? 'bold' : 'normal';
  input.style.fontStyle = textObj.italic ? 'italic' : 'normal';
  input.style.color = textObj.color || '#0f172a';

  if (lblSize) lblSize.textContent = `${textObj.fontSize || 16}pt`;
  if ($('btnTextBold')) $('btnTextBold').classList.toggle('active', !!textObj.bold);
  if ($('btnTextItalic')) $('btnTextItalic').classList.toggle('active', !!textObj.italic);

  document.querySelectorAll('.text-color-swatch').forEach(swatch => {
    swatch.classList.toggle('active', swatch.getAttribute('data-color') === textObj.color);
  });

  input.focus();
  if (!isNew) {
    input.select();
  }

  input.style.height = 'auto';
  input.style.height = `${Math.max(32, input.scrollHeight)}px`;
}

function commitActiveInlineTextEditor() {
  const overlay = $('inlineTextOverlay');
  const input = $('inlineTextInput');
  if (!overlay || overlay.classList.contains('hidden') || !state.activeTextEditorObj) return;

  const textObj = state.activeTextEditorObj;
  const val = input.value.trim();

  if (!val) {
    textObj.deleted = true;
    journalTextMutation('delete', textObj);
  } else {
    textObj.text = input.value;
    textObj.deleted = false;
    if (!state.textObjects.includes(textObj)) {
      state.textObjects.push(textObj);
      state.undoStack.push({ type: 'add_text_object', textObj });
      state.redoStack = [];
    }
    journalTextMutation('upsert', textObj);
  }

  markDirty();
  state.activeTextEditorObj = null;
  overlay.classList.add('hidden');
  redrawAll();
}

function initInlineTextEditor() {
  const overlay = $('inlineTextOverlay');
  const input = $('inlineTextInput');
  const btnDec = $('btnTextSizeDec');
  const btnInc = $('btnTextSizeInc');
  const btnBold = $('btnTextBold');
  const btnItalic = $('btnTextItalic');
  const btnDel = $('btnTextDeleteBox');
  const lblSize = $('lblTextSize');

  if (!input) return;

  if (overlay) {
    overlay.addEventListener('pointerdown', e => e.stopPropagation());
    overlay.addEventListener('mousedown', e => e.stopPropagation());
    overlay.addEventListener('click', e => e.stopPropagation());
  }

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.max(32, input.scrollHeight)}px`;
    if (state.activeTextEditorObj) {
      state.activeTextEditorObj.text = input.value;
    }
  });

  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      commitActiveInlineTextEditor();
    }
  });

  if (btnDec) {
    btnDec.addEventListener('click', () => {
      if (!state.activeTextEditorObj) return;
      state.activeTextEditorObj.fontSize = Math.max(10, (state.activeTextEditorObj.fontSize || 16) - 2);
      input.style.fontSize = `${state.activeTextEditorObj.fontSize}px`;
      if (lblSize) lblSize.textContent = `${state.activeTextEditorObj.fontSize}pt`;
      journalTextMutation('upsert', state.activeTextEditorObj);
      markDirty();
    });
  }

  if (btnInc) {
    btnInc.addEventListener('click', () => {
      if (!state.activeTextEditorObj) return;
      state.activeTextEditorObj.fontSize = Math.min(72, (state.activeTextEditorObj.fontSize || 16) + 2);
      input.style.fontSize = `${state.activeTextEditorObj.fontSize}px`;
      if (lblSize) lblSize.textContent = `${state.activeTextEditorObj.fontSize}pt`;
      journalTextMutation('upsert', state.activeTextEditorObj);
      markDirty();
    });
  }

  if (btnBold) {
    btnBold.addEventListener('click', () => {
      if (!state.activeTextEditorObj) return;
      state.activeTextEditorObj.bold = !state.activeTextEditorObj.bold;
      btnBold.classList.toggle('active', state.activeTextEditorObj.bold);
      input.style.fontWeight = state.activeTextEditorObj.bold ? 'bold' : 'normal';
      journalTextMutation('upsert', state.activeTextEditorObj);
      markDirty();
    });
  }

  if (btnItalic) {
    btnItalic.addEventListener('click', () => {
      if (!state.activeTextEditorObj) return;
      state.activeTextEditorObj.italic = !state.activeTextEditorObj.italic;
      btnItalic.classList.toggle('active', state.activeTextEditorObj.italic);
      input.style.fontStyle = state.activeTextEditorObj.italic ? 'italic' : 'normal';
      journalTextMutation('upsert', state.activeTextEditorObj);
      markDirty();
    });
  }

  if (btnDel) {
    btnDel.addEventListener('click', () => {
      if (state.activeTextEditorObj) {
        state.activeTextEditorObj.deleted = true;
        journalTextMutation('delete', state.activeTextEditorObj);
        state.undoStack.push({ type: 'delete_text_object', textObj: state.activeTextEditorObj });
        state.redoStack = [];
        markDirty();
      }
      state.activeTextEditorObj = null;
      overlay.classList.add('hidden');
      redrawAll();
    });
  }

  document.querySelectorAll('.text-color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      const color = swatch.getAttribute('data-color');
      if (color) {
        if (state.activeTextEditorObj) {
          state.activeTextEditorObj.color = color;
        }
        input.style.color = color;
        setColor(color, true, 'text');
      }
    });
  });
}

// ---- Blank Whiteboard Creation ----
async function createBlankWhiteboard() {
  const invoke = getInvoke();
  if (invoke) {
    try {
      showToast('Creating new whiteboard...', 'info');
      const res = await invoke('create_blank_document', {
        title: 'Untitled Whiteboard.pdf',
        widthPt: 842.0,
        heightPt: 595.0,
      });
      if (res && res.page_infos) {
        handlePdfLoadSuccess('Untitled Whiteboard.pdf', null, res.page_infos, res.recovered_strokes || 0, res.loaded_strokes || [], res.outline || []);
        showToast('Blank whiteboard ready!', 'success');
        return;
      }
    } catch (err) {
      console.warn('create_blank_document invoke failed, falling back locally:', err);
    }
  }

  // Fallback locally
  handlePdfLoadSuccess('Untitled Whiteboard.pdf', null, [{ page_index: 0, width_pt: 842.0, height_pt: 595.0 }], 0, [], []);
  showToast('Blank whiteboard ready!', 'success');
}

// ---- Clear Ink on Current Page ----
function clearCurrentPageInk() {
  const cur = state.leftSheet;
  const pageStrokes = state.strokes.filter(s => !s.deleted && s.sheet === cur);
  if (!pageStrokes.length) {
    showToast('No ink on current page', 'info');
    return;
  }
  for (const s of pageStrokes) {
    s.deleted = true;
  }
  state.undoStack.push({ type: 'erase', strokes: pageStrokes });
  state.redoStack = [];
  redrawAll();
  clearWet();
  showToast(`Cleared ${pageStrokes.length} stroke(s) on Page ${cur + 1}`, 'info');
}

// ---- Live Page Thumbnail Previews ----
let thumbObserver = null;
const renderedThumbnails = new Set();
const thumbQueue = [];
let activeThumbFetches = 0;
const MAX_CONCURRENT_THUMBS = 2;

let sharedThumbOffscreenCanvas = null;
function getSharedThumbOffscreenCanvas(w, h) {
  if (!sharedThumbOffscreenCanvas) {
    sharedThumbOffscreenCanvas = document.createElement('canvas');
  }
  sharedThumbOffscreenCanvas.width = w;
  sharedThumbOffscreenCanvas.height = h;
  return sharedThumbOffscreenCanvas;
}

let thumbScrollListenerAttached = false;
let thumbScrollRaf = null;

function pumpThumbQueue() {
  while (activeThumbFetches < MAX_CONCURRENT_THUMBS && thumbQueue.length > 0) {
    const task = thumbQueue.shift();
    if (!task) break;
    activeThumbFetches++;
    task().finally(() => {
      activeThumbFetches--;
      pumpThumbQueue();
    });
  }
}

async function renderThumbnails() {
  const grid = $('thumbnailGrid');
  const drawer = $('drawerThumbnails');
  if (!grid) return;
  if (!state.pageInfos || !state.pageInfos.length) {
    grid.innerHTML = '<div class="thumb-empty">No pages available</div>';
    grid.style.position = '';
    grid.style.height = '';
    return;
  }

  const pageCount = state.pageInfos.length;
  grid.style.position = '';
  grid.style.height = '';

  // Index strokes by sheet to avoid O(N) scanning across full document
  const strokesBySheet = new Map();
  for (const s of state.strokes) {
    if (s.deleted) continue;
    let list = strokesBySheet.get(s.sheet);
    if (!list) {
      list = [];
      strokesBySheet.set(s.sheet, list);
    }
    list.push(s);
  }

  const cardsHtml = [];
  for (let i = 0; i < pageCount; i++) {
    const pi = state.pageInfos[i];
    if (!pi) continue;
    const active = (i === state.leftSheet) ? ' active' : '';
    const aspect = (pi.height_pt && pi.width_pt) ? (pi.height_pt / pi.width_pt) : 1.414;

    cardsHtml.push(`
      <div class="thumb-card${active}" data-page="${i}" draggable="true">
        <div class="thumb-preview-wrap" style="aspect-ratio: 1 / ${aspect.toFixed(3)};">
          <canvas class="thumb-canvas" id="thumbCanvas_${i}" width="140" height="${Math.round(140 * aspect)}"></canvas>
          <div class="thumb-card-actions">
            <button type="button" class="btn-thumb-act btn-thumb-dup" data-act="dup" data-page="${i}" title="Duplicate page">❐</button>
            <button type="button" class="btn-thumb-act btn-thumb-rot" data-act="rot" data-page="${i}" title="Rotate 90° CW">↻</button>
            <button type="button" class="btn-thumb-act btn-thumb-del" data-act="del" data-page="${i}" title="Delete page">🗑</button>
          </div>
        </div>
        <span class="thumb-page-num">Page ${i + 1}</span>
      </div>
    `);
  }

  grid.innerHTML = cardsHtml.join('');

  grid.querySelectorAll('.thumb-card').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      const i = parseInt(el.getAttribute('data-page'), 10);
      e.dataTransfer.setData('text/plain', String(i));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      grid.querySelectorAll('.thumb-card').forEach(c => c.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIdx = parseInt(el.getAttribute('data-page'), 10);
      if (!isNaN(fromIdx) && !isNaN(toIdx) && fromIdx !== toIdx) {
        reorderPage(fromIdx, toIdx);
      }
    });

    el.addEventListener('click', (e) => {
      const btnAct = e.target.closest('.btn-thumb-act');
      if (btnAct) {
        e.stopPropagation();
        const act = btnAct.getAttribute('data-act');
        const pageIdx = parseInt(btnAct.getAttribute('data-page'), 10);
        if (act === 'dup') duplicateCurrentPage(pageIdx);
        else if (act === 'rot') rotateCurrentPage(pageIdx, true);
        else if (act === 'del') deleteCurrentPage(pageIdx);
        return;
      }
      const i = parseInt(el.getAttribute('data-page'), 10);
      if (!isNaN(i)) {
        const targetPane = (viewport && viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
        goToPage(i, targetPane);
      }
    });
  });

  function renderSingleThumbnail(i) {
    if (renderedThumbnails.has(i)) return;
    renderedThumbnails.add(i);

    thumbQueue.push(async () => {
      const pi = state.pageInfos[i];
      if (!pi) return;
      const canvas = $(`thumbCanvas_${i}`);
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = (pi.template === 'dark') ? '#0f172a' : '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (pi.template !== 'dark') {
        try {
          const tile = await fetchTile(i, [0, 0, pi.width_pt, pi.height_pt], 256);
          if (tile && tile.data) {
            ctx.drawImage(tile.data, 0, 0, canvas.width, canvas.height);
          }
        } catch (e) {
          console.warn('thumb render error for page', i, e);
        }
      }

      // Draw template guidelines in thumbnail
      if (pi.template && pi.template !== 'blank') {
        ctx.save();
        ctx.scale(canvas.width / pi.width_pt, canvas.height / pi.height_pt);
        drawPageTemplateGuidelines(ctx, pi.template, pi.width_pt, pi.height_pt);
        ctx.restore();
      }

      const pageStrokes = strokesBySheet.get(i) || [];
      if (pageStrokes.length) {
        ctx.save();
        const scaleX = canvas.width / pi.width_pt;
        const scaleY = canvas.height / pi.height_pt;
        ctx.scale(scaleX, scaleY);
        for (const stroke of pageStrokes) {
          ctx.strokeStyle = stroke.cssColor || `rgb(${stroke.rgb.map(v => Math.round(v * 255)).join(',')})`;
          ctx.lineWidth = Math.max(1, stroke.base_width);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.globalAlpha = (stroke.kind === 'highlighter') ? 0.42 : 1.0;
          if (stroke.points && stroke.points.length > 1) {
            ctx.beginPath();
            ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
            for (let p = 1; p < stroke.points.length; p++) {
              ctx.lineTo(stroke.points[p].x, stroke.points[p].y);
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    });
    pumpThumbQueue();
  }

  renderedThumbnails.clear();
  thumbQueue.length = 0;

  // Render first batch of visible thumbnails immediately
  for (let i = 0; i < pageCount; i++) {
    renderSingleThumbnail(i);
  }
}

function updateDocInfo() {
  const tab = state.tabs && state.tabs.find(t => t.id === state.activeTabId);
  const title = tab ? tab.title : 'Untitled.pdf';
  const nPages = state.pageInfos ? state.pageInfos.length : 0;
  const nStrokes = state.strokes ? state.strokes.filter(s => !s.deleted).length : 0;
  const curPage = (state.leftSheet != null) ? (state.leftSheet + 1) : 1;
  const curPageInfo = state.pageInfos ? state.pageInfos[state.leftSheet || 0] : null;

  let dimStr = 'A4 Portrait';
  if (curPageInfo && curPageInfo.width_pt && curPageInfo.height_pt) {
    const isLandscape = curPageInfo.width_pt > curPageInfo.height_pt;
    dimStr = `${Math.round(curPageInfo.width_pt)}×${Math.round(curPageInfo.height_pt)} pt (${isLandscape ? 'Landscape' : 'Portrait'})`;
  }

  if ($('docInfoTitle')) $('docInfoTitle').textContent = title;
  if ($('docStatPages')) $('docStatPages').textContent = `${nPages}`;
  if ($('docStatStrokes')) $('docStatStrokes').textContent = `${nStrokes}`;
  if ($('docStatCurrentPage')) $('docStatCurrentPage').textContent = `Page ${curPage} of ${nPages || 1}`;
  if ($('docStatDimensions')) $('docStatDimensions').textContent = dimStr;
  if ($('diagPointerType')) $('diagPointerType').textContent = state.lastPointerType === 'pen' ? 'Stylus Pen (Pressure Active)' : 'Mouse / Trackpad';
}

function updateToolBadges() {
  const nPages = state.pageInfos ? state.pageInfos.length : 0;
  const badge = $('badgeThumbnails');
  if (badge) badge.textContent = nPages || '';
}

function checkWalRecovery(recovered) {
  if (recovered && recovered > 0) {
    showToast(`Restored ${recovered} unsaved stroke${recovered > 1 ? 's' : ''} from crash journal`, 'info');
  }
}

// ---- Page navigation history (header Back / Forward) ----
function pushNav(i) {
  if (!Array.isArray(state.navHistory)) state.navHistory = [];
  if (state.navIndex == null) state.navIndex = -1;
  if (state.navHistory[state.navIndex] === i) return;
  state.navHistory.splice(state.navIndex + 1);
  state.navHistory.push(i);
  state.navIndex = state.navHistory.length - 1;
  if (state.navHistory.length > 200) { state.navHistory.shift(); state.navIndex--; }
}

function jumpToPage(i) {
  if (i < 0 || i >= state.pageInfos.length) return;
  state.leftSheet = i;
  const pi = state.pageInfos[i];
  recenterPanesOnly(pi);
  updatePageUI();
  scheduleRedrawTiles();
  redrawAll();
  prefetchAdjacentPages();
}

function goBack() {
  if (!Array.isArray(state.navHistory) || state.navIndex <= 0) return;
  state.navIndex--;
  jumpToPage(state.navHistory[state.navIndex]);
}

function goForward() {
  if (!Array.isArray(state.navHistory) || state.navIndex >= state.navHistory.length - 1) return;
  state.navIndex++;
  jumpToPage(state.navHistory[state.navIndex]);
}

// ---- UI binding ----
function bindUI() {
  // Legacy toolbar buttons
  $('btnPen') && $('btnPen').addEventListener('click', () => setTool('pen'));
  $('btnHighlighter') && $('btnHighlighter').addEventListener('click', () => setTool('highlighter'));
  $('btnEraser') && $('btnEraser').addEventListener('click', () => setTool('eraser'));
  $('btnPan') && $('btnPan').addEventListener('click', () => setTool('pan'));
  $('btnLasso') && $('btnLasso').addEventListener('click', () => setTool('lasso'));
  $('btnRuler') && $('btnRuler').addEventListener('click', () => setTool('ruler'));
  $('btnRect') && $('btnRect').addEventListener('click', () => setTool('rect'));
  $('btnEllipse') && $('btnEllipse').addEventListener('click', () => setTool('ellipse'));
  $('btnLaser') && $('btnLaser').addEventListener('click', () => setTool('laser'));

  // Floating Dock tool buttons
  $('btnDockPan') && $('btnDockPan').addEventListener('click', () => setTool('pan'));
  $('btnDockLasso') && $('btnDockLasso').addEventListener('click', () => setTool('lasso'));
  $('btnDockPen') && $('btnDockPen').addEventListener('click', () => {
    if (state.activeTool === 'pen') {
      const pop = $('propPopover');
      if (pop) {
        const willShow = pop.classList.contains('hidden');
        pop.classList.toggle('hidden');
        if (willShow) updateToolInspectorUI();
      }
    } else {
      setTool('pen');
    }
  });
  $('btnDockHighlighter') && $('btnDockHighlighter').addEventListener('click', () => {
    if (state.activeTool === 'highlighter') {
      const pop = $('propPopover');
      if (pop) {
        const willShow = pop.classList.contains('hidden');
        pop.classList.toggle('hidden');
        if (willShow) updateToolInspectorUI();
      }
    } else {
      setTool('highlighter');
    }
  });
  $('btnDockEraser') && $('btnDockEraser').addEventListener('click', () => {
    if (state.activeTool === 'eraser') {
      const pop = $('propPopover');
      if (pop) {
        const willShow = pop.classList.contains('hidden');
        pop.classList.toggle('hidden');
        if (willShow) updateToolInspectorUI();
      }
    } else {
      setTool('eraser');
    }
  });
  $('btnDockLaser') && $('btnDockLaser').addEventListener('click', () => setTool('laser'));
  $('btnDockShapes') && $('btnDockShapes').addEventListener('click', () => {
    if (state.activeTool === 'rect') {
      setTool('ellipse');
      showToast('Shape: Ellipse (O)', 'info');
    } else if (state.activeTool === 'ellipse') {
      setTool('ruler');
      showToast('Shape: Ruler Line (R)', 'info');
    } else {
      setTool('rect');
      showToast('Shape: Rectangle (U)', 'info');
    }
  });
  $('btnDockText') && $('btnDockText').addEventListener('click', () => {
    setTool('text');
    showToast('Text Tool (T): Click on page to annotate', 'info');
  });
  $('btnDockAddPreset') && $('btnDockAddPreset').addEventListener('click', () => {
    const pop = $('propPopover');
    if (pop) {
      const willShow = pop.classList.contains('hidden');
      pop.classList.toggle('hidden');
      if (willShow) updateToolInspectorUI();
    }
  });
  $('btnDockStylusOptions') && $('btnDockStylusOptions').addEventListener('click', () => openSettingsModal());

  // Left Navigation Rail buttons
  $('btnRailThumbnails') && $('btnRailThumbnails').addEventListener('click', () => toggleDrawer('thumbnails'));
  $('btnRailOutline') && $('btnRailOutline').addEventListener('click', () => toggleDrawer('outline'));
  $('btnRailSearch') && $('btnRailSearch').addEventListener('click', () => toggleDrawer('search'));
  $('btnRailBookmarks') && $('btnRailBookmarks').addEventListener('click', () => toggleDrawer('bookmarks'));
  $('btnRailLayers') && $('btnRailLayers').addEventListener('click', () => toggleDrawer('layers'));
  $('btnRailSplit') && $('btnRailSplit').addEventListener('click', toggleSplitView);
  $('btnRailDocInfo') && $('btnRailDocInfo').addEventListener('click', () => toggleDrawer('docInfo'));
  $('btnRailSettings') && $('btnRailSettings').addEventListener('click', () => openSettingsModal());
  $('btnRailMore') && $('btnRailMore').addEventListener('click', () => $('moreOptionsMenu') && $('moreOptionsMenu').classList.toggle('hidden'));

  // More Options Menu Items
  $('btnMoreNewNote') && $('btnMoreNewNote').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    createBlankWhiteboard();
  });
  $('btnMoreAddPage') && $('btnMoreAddPage').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    insertBlankPage();
  });
  $('btnMoreClearInk') && $('btnMoreClearInk').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    clearCurrentPageInk();
  });
  $('btnMorePalette') && $('btnMorePalette').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    openCommandPalette();
  });
  $('btnMoreFullscreen') && $('btnMoreFullscreen').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    toggleFullscreen();
  });

  // Document Info Drawer Actions
  $('btnDocInfoExport') && $('btnDocInfoExport').addEventListener('click', () => $('exportModal') && $('exportModal').classList.remove('hidden'));
  $('btnDocInfoInsertPage') && $('btnDocInfoInsertPage').addEventListener('click', insertBlankPage);
  $('btnDocInfoNewWhiteboard') && $('btnDocInfoNewWhiteboard').addEventListener('click', createBlankWhiteboard);
  $('btnDocInfoClearInk') && $('btnDocInfoClearInk').addEventListener('click', clearCurrentPageInk);

  $('btnCloseDrawer') && $('btnCloseDrawer').addEventListener('click', () => {
    const drawer = $('navDrawer');
    if (drawer) drawer.classList.add('hidden');
    state.activeDrawer = null;
    updateRailButtonsUI();
  });

  // Top Header controls
  $('btnHeaderNewNote') && $('btnHeaderNewNote').addEventListener('click', createBlankWhiteboard);
  $('btnWelcomeNewNote') && $('btnWelcomeNewNote').addEventListener('click', createBlankWhiteboard);

  // Search & Bookmarks actions
  $('btnExecuteSearch') && $('btnExecuteSearch').addEventListener('click', () => executeSearch());
  $('drawerSearchInput') && $('drawerSearchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeSearch();
    }
  });
  $('btnAddBookmark') && $('btnAddBookmark').addEventListener('click', addBookmarkForCurrentPage);

  // Top Header controls
  $('btnNewTab') && $('btnNewTab').addEventListener('click', () => $('btnHeaderOpen') && $('btnHeaderOpen').click());
  $('btnNavBack') && $('btnNavBack').addEventListener('click', goBack);
  $('btnNavForward') && $('btnNavForward').addEventListener('click', goForward);

  // Modal triggers & Quick actions
  $('btnHeaderAddPage') && $('btnHeaderAddPage').addEventListener('click', (e) => {
    if (e.shiftKey) insertBlankPage();
    else openInsertPageModal();
  });
  $('btnAddPage') && $('btnAddPage').addEventListener('click', () => openInsertPageModal());
  $('btnInsertBlank') && $('btnInsertBlank').addEventListener('click', () => openInsertPageModal());
  $('btnDocInfoInsertPage') && $('btnDocInfoInsertPage').addEventListener('click', () => openInsertPageModal());
  $('btnMoreAddPage') && $('btnMoreAddPage').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    openInsertPageModal();
  });

  // Insert Page Modal Form & Selectors
  $('insertPaperSizeSelect') && $('insertPaperSizeSelect').addEventListener('change', (e) => {
    const isCustom = e.target.value === 'custom';
    $('customDimRow') && $('customDimRow').classList.toggle('hidden', !isCustom);
  });
  $('btnCloseInsertPageModal') && $('btnCloseInsertPageModal').addEventListener('click', closeInsertPageModal);
  $('btnCancelInsertPage') && $('btnCancelInsertPage').addEventListener('click', closeInsertPageModal);
  $('insertPageModal') && $('insertPageModal').addEventListener('click', (e) => {
    if (e.target === $('insertPageModal')) closeInsertPageModal();
  });
  $('insertPageForm') && $('insertPageForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const position = $('insertPositionSelect') ? $('insertPositionSelect').value : 'after_current';
    const paperSize = $('insertPaperSizeSelect') ? $('insertPaperSizeSelect').value : 'match_current';
    const customWidth = $('customPageWidth') ? $('customPageWidth').value : 595;
    const customHeight = $('customPageHeight') ? $('customPageHeight').value : 842;
    const orientation = document.querySelector('input[name="pageOrientation"]:checked')?.value || 'portrait';
    const template = $('insertTemplateSelect') ? $('insertTemplateSelect').value : 'blank';
    closeInsertPageModal();
    insertBlankPage({ position, paperSize, customWidth, customHeight, orientation, template });
  });

  // Go to Page Modal triggers & form
  $('btnPageDropdown') && $('btnPageDropdown').addEventListener('click', () => openGoToPageModal());
  $('pageNumDisplay') && $('pageNumDisplay').addEventListener('click', () => openGoToPageModal());
  $('btnCloseGoToPageModal') && $('btnCloseGoToPageModal').addEventListener('click', closeGoToPageModal);
  $('btnCancelGoToPage') && $('btnCancelGoToPage').addEventListener('click', closeGoToPageModal);
  $('goToPageModal') && $('goToPageModal').addEventListener('click', (e) => {
    if (e.target === $('goToPageModal')) closeGoToPageModal();
  });
  $('btnJumpFirstPage') && $('btnJumpFirstPage').addEventListener('click', () => {
    closeGoToPageModal();
    goToPage(0, 'left');
  });
  $('btnJumpLastPage') && $('btnJumpLastPage').addEventListener('click', () => {
    closeGoToPageModal();
    if (state.pageInfos && state.pageInfos.length) {
      goToPage(state.pageInfos.length - 1, 'left');
    }
  });
  $('goToPageForm') && $('goToPageForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('goToPageInput');
    const val = input ? parseInt(input.value, 10) : 1;
    closeGoToPageModal();
    if (!isNaN(val) && val >= 1) {
      goToPage(val - 1, 'left');
    }
  });

  // Shortcuts modal
  $('btnCloseShortcutsModal') && $('btnCloseShortcutsModal').addEventListener('click', closeShortcutsModal);
  $('shortcutsModal') && $('shortcutsModal').addEventListener('click', (e) => {
    if (e.target === $('shortcutsModal')) closeShortcutsModal();
  });

  // Save & Export controls
  $('btnExportShare') && $('btnExportShare').addEventListener('click', () => saveDocument(false));
  $('btnCloseExportModal') && $('btnCloseExportModal').addEventListener('click', () => $('exportModal') && $('exportModal').classList.add('hidden'));
  $('exportModal') && $('exportModal').addEventListener('click', e => {
    if (e.target === $('exportModal')) $('exportModal').classList.add('hidden');
  });
  $('btnExportIncremental') && $('btnExportIncremental').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.add('hidden');
    saveDocument(false);
  });
  $('btnExportFlattened') && $('btnExportFlattened').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.add('hidden');
    saveDocument(true);
  });

  // Scroll to Top
  $('btnScrollTop') && $('btnScrollTop').addEventListener('click', () => goToPage(0));

  $('colorPicker') && $('colorPicker').addEventListener('input', e => {
    setColor(e.target.value, true);
  });

  $('btnUndo') && $('btnUndo').addEventListener('click', undo);
  $('btnRedo') && $('btnRedo').addEventListener('click', redo);

  $('btnSplit') && $('btnSplit').addEventListener('click', toggleSplitView);
  $('btnZoomSplit') && $('btnZoomSplit').addEventListener('click', toggleSplitView);

  $('btnZoomIn') && $('btnZoomIn').addEventListener('click', zoomIn);
  $('btnZoomOut') && $('btnZoomOut').addEventListener('click', zoomOut);
  $('btnZoomFit') && $('btnZoomFit').addEventListener('click', zoomFit);
  $('btnFullscreen') && $('btnFullscreen').addEventListener('click', toggleFullscreen);

  // Zoom presets menu popover
  $('btnZoomMenu') && $('btnZoomMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('zoomMenuPopover');
    if (pop) pop.classList.toggle('hidden');
  });

  const zoomPop = $('zoomMenuPopover');
  if (zoomPop) {
    ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'touchstart', 'touchmove', 'touchend', 'wheel'].forEach(evt => {
      zoomPop.addEventListener(evt, e => e.stopPropagation());
    });
  }

  document.querySelectorAll('.zoom-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const zoomVal = btn.getAttribute('data-zoom');
      if (zoomVal === 'fit-page') {
        zoomFit();
      } else if (zoomVal === 'fit-width') {
        zoomFitWidth();
      } else {
        const factor = parseFloat(zoomVal);
        if (!isNaN(factor) && viewport) {
          const pane = (viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
          const stageRect = viewport.stageRect || $('stage').getBoundingClientRect();
          const center = [stageRect.width / 2, stageRect.height / 2];
          viewport.setZoom(factor, center, pane);
          updateZoomUI();
        }
      }
      $('zoomMenuPopover') && $('zoomMenuPopover').classList.add('hidden');
    });
  });

  $('btnApplyCustomZoom') && $('btnApplyCustomZoom').addEventListener('click', () => {
    const input = $('inputCustomZoom');
    if (input && input.value && viewport) {
      const pct = parseFloat(input.value);
      if (!isNaN(pct) && pct >= 10 && pct <= 800) {
        const factor = pct / 100.0;
        const pane = (viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
        const stageRect = viewport.stageRect || $('stage').getBoundingClientRect();
        const center = [stageRect.width / 2, stageRect.height / 2];
        viewport.setZoom(factor, center, pane);
        updateZoomUI();
        input.value = '';
      }
    }
    $('zoomMenuPopover') && $('zoomMenuPopover').classList.add('hidden');
  });

  $('inputCustomZoom') && $('inputCustomZoom').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btnApplyCustomZoom') && $('btnApplyCustomZoom').click();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#zoomMenuPopover') && !e.target.closest('#btnZoomMenu')) {
      $('zoomMenuPopover') && $('zoomMenuPopover').classList.add('hidden');
    }
  });

  // Top header quick actions
  $('btnHeaderSave') && $('btnHeaderSave').addEventListener('click', () => saveDocument(false));
  $('btnHeaderExport') && $('btnHeaderExport').addEventListener('click', () => $('exportModal') && $('exportModal').classList.remove('hidden'));
  $('btnHeaderFind') && $('btnHeaderFind').addEventListener('click', () => toggleDrawer('search'));
  $('btnHeaderSettings') && $('btnHeaderSettings').addEventListener('click', () => openSettingsModal());
  $('btnClearRecents') && $('btnClearRecents').addEventListener('click', () => clearRecentFiles());

  // Startup session restore checkbox in Settings modal
  const cRestoreSession = $('cRestoreSession');
  if (cRestoreSession) {
    cRestoreSession.checked = localStorage.getItem('inkwell_restore_session_enabled') === 'true';
    cRestoreSession.addEventListener('change', () => {
      localStorage.setItem('inkwell_restore_session_enabled', cRestoreSession.checked ? 'true' : 'false');
      showToast(cRestoreSession.checked ? 'Session auto-restore enabled on startup' : 'Clean Welcome Screen enabled on startup', 'info');
    });
  }

  $('btnToggleSidebar') && $('btnToggleSidebar').addEventListener('click', toggleSidebar);
  $('btnCollapseSidebar') && $('btnCollapseSidebar').addEventListener('click', toggleSidebar);
  $('btnCmdPalette') && $('btnCmdPalette').addEventListener('click', openCommandPalette);

  // Property popover binding & pointer event isolation
  const propPop = $('propPopover');
  if (propPop) {
    ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'touchstart', 'touchmove', 'touchend', 'wheel'].forEach(evt => {
      propPop.addEventListener(evt, e => e.stopPropagation());
    });
  }

  $('btnProp') && $('btnProp').addEventListener('click', () => {
    const pop = $('propPopover');
    if (pop) {
      const willShow = pop.classList.contains('hidden');
      pop.classList.toggle('hidden');
      if (willShow) updateToolInspectorUI();
    }
  });

  $('btnClosePropPopover') && $('btnClosePropPopover').addEventListener('click', () => {
    $('propPopover') && $('propPopover').classList.add('hidden');
  });

  // Settings Modal Window Setup & Tab Switching
  const settingsMod = $('settingsModal');
  if (settingsMod) {
    ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'touchstart', 'touchmove', 'touchend', 'wheel'].forEach(evt => {
      settingsMod.addEventListener(evt, e => e.stopPropagation());
    });
    settingsMod.addEventListener('click', (e) => {
      if (e.target === settingsMod) closeSettingsModal();
    });
  }
  $('btnCloseSettingsModal') && $('btnCloseSettingsModal').addEventListener('click', closeSettingsModal);
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab) switchSettingsTab(tab);
    });
  });

  $('widthSlider') && $('widthSlider').addEventListener('input', e => {
    const w = parseFloat(e.target.value);
    state.baseWidth = w;
    if (state.activeTool === 'highlighter') state.highlighterWidth = w;
    else state.penWidth = w;
    if ($('widthVal')) $('widthVal').textContent = state.baseWidth + ' pt';
    if ($('popoverWidthSlider')) $('popoverWidthSlider').value = String(state.baseWidth);
    if ($('popoverWidthVal')) $('popoverWidthVal').textContent = state.baseWidth + ' pt';
    applyWidthToSelection(state.baseWidth);
    updateToolBadges();
    drawStrokePreview();
  });

  $('popoverWidthSlider') && $('popoverWidthSlider').addEventListener('input', e => {
    const w = parseFloat(e.target.value);
    state.baseWidth = w;
    if (state.activeTool === 'highlighter') state.highlighterWidth = w;
    else state.penWidth = w;
    if ($('popoverWidthVal')) $('popoverWidthVal').textContent = state.baseWidth + ' pt';
    if ($('widthVal')) $('widthVal').textContent = state.baseWidth + ' pt';
    if ($('widthSlider')) $('widthSlider').value = String(state.baseWidth);
    // Update preset pills active state
    document.querySelectorAll('.btn-width-preset').forEach(btn => {
      const pw = parseFloat(btn.getAttribute('data-width'));
      btn.classList.toggle('active', Math.abs(pw - state.baseWidth) < 0.15);
    });
    applyWidthToSelection(state.baseWidth);
    updateToolBadges();
    drawStrokePreview();
  });

  // Width preset buttons
  document.querySelectorAll('.btn-width-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = parseFloat(btn.getAttribute('data-width'));
      if (!isNaN(w)) {
        state.baseWidth = w;
        if (state.activeTool === 'highlighter') state.highlighterWidth = w;
        else state.penWidth = w;
        if ($('popoverWidthSlider')) $('popoverWidthSlider').value = String(w);
        if ($('popoverWidthVal')) $('popoverWidthVal').textContent = w + ' pt';
        if ($('widthSlider')) $('widthSlider').value = String(w);
        if ($('widthVal')) $('widthVal').textContent = w + ' pt';
        document.querySelectorAll('.btn-width-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyWidthToSelection(w);
        updateToolBadges();
        drawStrokePreview();
      }
    });
  });

  // Custom HEX picker in popover
  const customPopPicker = $('popoverCustomColorPicker');
  if (customPopPicker) {
    customPopPicker.addEventListener('input', e => {
      setColor(e.target.value, true);
      drawStrokePreview();
    });
  }

  document.querySelectorAll('.swatch, .settings-color-swatch').forEach(s => {
    s.addEventListener('click', e => {
      const hex = e.target.getAttribute('data-color');
      if (!hex) return;
      setColor(hex, true);
      drawStrokePreview();
    });
  });

  // Page Navigation Buttons (Header & Canvas Edge Flippers & Split Controls)
  $('btnHeaderPrevPage') && $('btnHeaderPrevPage').addEventListener('click', () => goToPage(state.leftSheet - 1, 'left'));
  $('btnHeaderNextPage') && $('btnHeaderNextPage').addEventListener('click', () => goToPage(state.leftSheet + 1, 'left'));
  $('btnCanvasPrevPage') && $('btnCanvasPrevPage').addEventListener('click', () => goToPage(state.leftSheet - 1, 'left'));
  $('btnCanvasNextPage') && $('btnCanvasNextPage').addEventListener('click', () => {
    if (viewport && viewport.splitMode) {
      goToPage(state.rightSheet + 1, 'right');
    } else {
      goToPage(state.leftSheet + 1, 'left');
    }
  });

  $('btnLeftPanePrev') && $('btnLeftPanePrev').addEventListener('click', () => goToPage(state.leftSheet - 1, 'left'));
  $('btnLeftPaneNext') && $('btnLeftPaneNext').addEventListener('click', () => goToPage(state.leftSheet + 1, 'left'));
  $('btnRightPanePrev') && $('btnRightPanePrev').addEventListener('click', () => goToPage(state.rightSheet - 1, 'right'));
  $('btnRightPaneNext') && $('btnRightPaneNext').addEventListener('click', () => goToPage(state.rightSheet + 1, 'right'));

  $('btnOutlineAddBookmark') && $('btnOutlineAddBookmark').addEventListener('click', addBookmarkForCurrentPage);

  $('btnPrev') && $('btnPrev').addEventListener('click', () => goToPage(state.leftSheet - 1, 'left'));
  $('btnNext') && $('btnNext').addEventListener('click', () => goToPage(state.leftSheet + 1, 'left'));

  $('btnRightPrev') && $('btnRightPrev').addEventListener('click', () => goToPage(state.rightSheet - 1, 'right'));
  $('btnRightNext') && $('btnRightNext').addEventListener('click', () => goToPage(state.rightSheet + 1, 'right'));

  // Settings Drawer triggers & selectors
  $('btnOpenShortcutsFromSettings') && $('btnOpenShortcutsFromSettings').addEventListener('click', openShortcutsModal);

  const selectDefTpl = $('selectDefaultTemplate');
  if (selectDefTpl) {
    selectDefTpl.value = localStorage.getItem('inkwell_default_template') || 'blank';
    selectDefTpl.addEventListener('change', e => {
      localStorage.setItem('inkwell_default_template', e.target.value);
      showToast(`Default page template set to: ${e.target.options[e.target.selectedIndex].text}`, 'info');
    });
  }

  const selectAutosave = $('selectAutosaveDelay');
  if (selectAutosave) {
    selectAutosave.value = String(state.autosaveDelayMs);
    selectAutosave.addEventListener('change', e => {
      state.autosaveDelayMs = parseInt(e.target.value, 10) || 0;
      localStorage.setItem('inkwell_autosave_delay', String(state.autosaveDelayMs));
      if (state.autosaveDelayMs > 0 && state.isDirty) {
        triggerAutosaveDebounced();
      }
      showToast(state.autosaveDelayMs > 0 ? `Autosave delay set to ${state.autosaveDelayMs / 1000}s` : 'Autosave disabled (Manual Ctrl+S only)', 'info');
    });
  }
}

function showSaveProgress(show, message = 'Saving document...') {
  const overlay = $('saveProgressOverlay');
  const msgEl = $('saveProgressMsg');
  const btnExport = $('btnExportShare');
  const btnSave = $('btnSave');
  const statusBadge = $('docStatusBadge');
  const statusText = $('docStatusText');

  if (show) {
    if (overlay) {
      if (msgEl) msgEl.textContent = message;
      overlay.classList.remove('hidden');
    }
    if (btnExport) {
      btnExport.classList.add('is-saving');
      btnExport.disabled = true;
    }
    if (btnSave) btnSave.disabled = true;
    if (statusBadge && statusText) {
      statusBadge.classList.add('saving');
      statusText.textContent = 'Saving...';
    }
  } else {
    if (overlay) overlay.classList.add('hidden');
    if (btnExport) {
      btnExport.classList.remove('is-saving');
      btnExport.disabled = false;
    }
    if (btnSave) btnSave.disabled = false;
    if (statusBadge && statusText) {
      statusBadge.classList.remove('saving');
      statusText.textContent = 'Vector Ready';
    }
  }
}

function handlePdfLoadSuccess(title, selectedPath, infosOrResult, recovered = 0, loadedStrokes = [], outline = [], recoveredImages = 0, recoveredTexts = 0, loadedImages = [], loadedTexts = []) {
  try {
    let infos = infosOrResult;
    if (infosOrResult && typeof infosOrResult === 'object' && !Array.isArray(infosOrResult)) {
      const r = infosOrResult;
      infos = r.page_infos || [];
      recovered = r.recovered_strokes || 0;
      loadedStrokes = r.loaded_strokes || [];
      outline = r.outline || [];
      recoveredImages = r.recovered_images || 0;
      recoveredTexts = r.recovered_texts || 0;
      loadedImages = r.loaded_images || [];
      loadedTexts = r.loaded_texts || [];
    }

    state.outline = outline || [];
    const formattedStrokes = Array.isArray(loadedStrokes) ? loadedStrokes.map(s => {
      const strokeRec = {
        id: s.id,
        kind: s.kind,
        rgb: s.rgb,
        base_width: s.base_width,
        points: (s.points || []).map(p => ({ x: p.x, y: p.y, w: p.w, p: p.p, t: p.t })),
        sheet: s.sheet || 0,
        deleted: !!s.deleted,
      };
      if (typeof Ink.getPath2D === 'function') {
        strokeRec._cachedPath2D = Ink.getPath2D(strokeRec);
      }
      return strokeRec;
    }) : [];

    const formattedImages = Array.isArray(loadedImages) ? loadedImages.map(img => {
      const imgEl = new Image();
      imgEl.src = img.data_url || img.dataUrl || '';
      return {
        id: img.id,
        sheet: img.sheet || 0,
        x: img.x,
        y: img.y,
        width: img.width,
        height: img.height,
        dataUrl: img.data_url || img.dataUrl || '',
        _el: imgEl,
        deleted: false,
      };
    }) : [];

    const formattedTexts = Array.isArray(loadedTexts) ? loadedTexts.map(t => ({
      id: t.id,
      sheet: t.sheet || 0,
      x: t.x,
      y: t.y,
      text: t.text || '',
      fontSize: t.font_size || t.fontSize || 16,
      color: t.color || '#141724',
      bold: !!t.bold,
      italic: !!t.italic,
      width: t.width || 120,
      height: t.height || 30,
      deleted: false,
    })) : [];

    if (!state.tabs.length) {
      const tab = createTab(title, selectedPath, infos);
      if (tab) {
        tab.strokes = formattedStrokes;
        tab.images = formattedImages;
        tab.textObjects = formattedTexts;
        tab.outline = outline || [];
        state.strokes = tab.strokes;
        state.images = tab.images;
        state.textObjects = tab.textObjects;
      }
    } else {
      const cur = state.tabs.find(t => t.id === state.activeTabId);
      if (cur && (!cur.pathStr && (!cur.strokes || cur.strokes.length === 0) && (!cur.pageInfos || cur.pageInfos.length === 0))) {
        cur.title = title;
        cur.pathStr = selectedPath;
        cur.pageInfos = infos;
        cur.strokes = formattedStrokes;
        cur.images = formattedImages;
        cur.textObjects = formattedTexts;
        cur.outline = outline || [];
        cur.selectedStrokes = [];
        cur.selectedImages = [];
        cur.selectedTextObjects = [];
        cur.undoStack = [];
        cur.redoStack = [];
        cur.leftSheet = 0;
        cur.rightSheet = 0;
        state.strokes = cur.strokes;
        state.images = cur.images;
        state.textObjects = cur.textObjects;
        switchTab(cur.id);
      } else {
        const tab = createTab(title, selectedPath, infos);
        if (tab) {
          tab.strokes = formattedStrokes;
          tab.images = formattedImages;
          tab.textObjects = formattedTexts;
          tab.outline = outline || [];
          state.strokes = tab.strokes;
          state.images = tab.images;
          state.textObjects = tab.textObjects;
        }
      }
    }
    viewport.updateDocumentLayout(state.pageInfos);
    viewport.fitPage(state.pageInfos[0]?.width_pt, state.pageInfos[0]?.height_pt, 'left');
    renderOutline();
    if ($('welcomeDropzone')) $('welcomeDropzone').classList.add('hidden');
    scheduleRedrawAll();
    scheduleRedrawTiles();
    updateDocScrollbar();

    const totalRecovered = (recovered || 0) + (recoveredImages || 0) + (recoveredTexts || 0);
    if (totalRecovered > 0) {
      showToast(`Restored ${recovered || 0} strokes, ${recoveredImages || 0} images, ${recoveredTexts || 0} text notes from crash journal`, 'info');
      markDirty();
    }
  } catch (err) {
    console.error('[inkwell] handlePdfLoadSuccess setup error:', err);
  }
  updateToolBadges();
}

function attachOpenListeners() {
  const triggerOpen = async () => {
    const invoke = getInvoke();
    if (invoke) {
      try {
        const res = await invoke('open_pdf_dialog');
        if (res && res[0]) {
          const selectedPath = res[0];
          const r = res[1] || {};
          const title = selectedPath.split('\\').pop().split('/').pop();
          handlePdfLoadSuccess(title, selectedPath, r);
        }
        return;
      } catch (err) {
        if (err === 'CANCELLED' || err === 'No file selected') return;
        console.warn('[inkwell] Native open_pdf_dialog failed, trying file input:', err);
      }
    }
    $('pdfFileInput') && $('pdfFileInput').click();
  };

  const onOpenBtnClick = () => {
    const invoke = getInvoke();
    if (!invoke) {
      $('pdfFileInput') && $('pdfFileInput').click();
    } else {
      triggerOpen();
    }
  };

  $('btnHeaderOpen') && $('btnHeaderOpen').addEventListener('click', onOpenBtnClick);
  $('btnWelcomeOpen') && $('btnWelcomeOpen').addEventListener('click', onOpenBtnClick);
  $('btnOpen') && $('btnOpen').addEventListener('click', onOpenBtnClick);

  $('pdfFileInput') && $('pdfFileInput').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const invoke = getInvoke();
      const filePath = file.path || file.webkitRelativePath;
      if (filePath && invoke) {
        const r = await invoke('open_pdf', { pathStr: filePath });
        handlePdfLoadSuccess(file.name, filePath, r);
        return;
      }

      const arrayBuf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(arrayBuf));
      if (bytes.length > 5 * 1024 * 1024) {
        console.warn('[inkwell] Large PDF (>5 MB) sent via IPC bytes path — this may be slow or fail.');
      }
      if (invoke) {
        const r2 = await invoke('open_pdf_bytes', { name: file.name, bytes });
        handlePdfLoadSuccess(file.name, null, r2);
        return;
      }
      showToast('Tauri IPC is unavailable in this environment.', 'warning');
    } catch (err) {
      console.error('[inkwell] pdfFileInput error:', err);
      showToast('Failed to open PDF: ' + (err.message || err), 'error');
    }
  });
}

// ---- Document Saving & Exporting ----
async function saveDocument(forceSaveAs = false, isAutosave = false) {
  const invoke = getInvoke();
  if (!invoke) {
    if (!isAutosave) showToast('Running in browser mode. Native Tauri host required to save.', 'warning');
    return;
  }
  if (!isAutosave) {
    showSaveProgress(true, forceSaveAs ? 'Exporting PDF copy...' : 'Writing vector ink layers to PDF...');
  } else {
    updateSaveStatusUI('saving');
  }

  try {
    let savedPath;
    const curTab = state.tabs && state.tabs.find(t => t.id === state.activeTabId);
    const hasPath = curTab && curTab.pathStr;

    if (isAutosave && !hasPath) {
      return; // Do not pop up modal dialog during background autosave
    }

    const nonDeletedImages = (state.images || [])
      .filter(img => !img.deleted && img.dataUrl)
      .map(img => ({
        sheet: img.sheet || 0,
        x: img.x,
        y: img.y,
        width: img.width,
        height: img.height,
        data_url: img.dataUrl,
      }));

    const textImages = (state.textObjects || [])
      .filter(t => !t.deleted && t.text && t.text.trim())
      .map(renderTextObjectToDataUrl);

    const templateImages = (state.pageInfos || [])
      .map((pi, idx) => (pi && pi.template && pi.template !== 'blank') ? renderPageTemplateBackgroundToDataUrl(pi, idx) : null)
      .filter(Boolean);

    const allImages = [...templateImages, ...nonDeletedImages, ...textImages];

    const nonDeletedStrokes = (state.strokes || [])
      .filter(s => !s.deleted)
      .map(s => ({
        id: String(s.id),
        kind: s.kind || 'pen',
        rgb: s.rgb || [0, 0, 0],
        base_width: s.base_width || s.baseWidth || 2.0,
        sheet: s.sheet || 0,
        deleted: false,
        points: (s.points || []).map(p => ({
          x: p.x,
          y: p.y,
          w: p.w || 2.0,
          p: p.p || 0.5,
          t: p.t || 0,
        })),
      }));

    if (!forceSaveAs && hasPath) {
      try {
        savedPath = await invoke('save_pdf', {
          outPathStr: curTab.pathStr,
          images: allImages,
          strokes: nonDeletedStrokes,
        });
      } catch (err) {
        if (!isAutosave) {
          console.warn('[inkwell] Direct save_pdf failed, opening save dialog:', err);
          savedPath = await invoke('save_pdf_dialog', {
            images: allImages,
            strokes: nonDeletedStrokes,
          });
        } else {
          throw err;
        }
      }
    } else if (!isAutosave) {
      savedPath = await invoke('save_pdf_dialog', {
        images: allImages,
        strokes: nonDeletedStrokes,
      });
    }

    if (savedPath) {
      if (curTab) {
        curTab.pathStr = savedPath;
        curTab.title = savedPath.split('\\').pop().split('/').pop();
        renderTabsDOM();
        if ($('activeTabTitle')) $('activeTabTitle').textContent = curTab.title;
      }
      state.isDirty = false;
      updateSaveStatusUI('saved');
      persistSessionState();
      updateDocInfo();
      if (!isAutosave) {
        showSaveProgress(false);
        showToast('Saved successfully to: ' + savedPath, 'success');
      }
    } else {
      if (!isAutosave) showSaveProgress(false);
    }
  } catch (err) {
    if (!isAutosave) {
      showSaveProgress(false);
      if (err === 'CANCELLED') {
        showToast('Save cancelled', 'info');
        return;
      }
      console.error('[inkwell] saveDocument failed:', err);
      showToast('Save failed: ' + (err.message || err), 'error');
    } else {
      updateSaveStatusUI('dirty');
    }
  }
}
window.saveDocument = saveDocument;

  // Export / Save Modal Option Cards & Buttons
  $('btnExportDirect') && $('btnExportDirect').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.add('hidden');
    saveDocument(false);
  });
  $('btnExportFlattened') && $('btnExportFlattened').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.add('hidden');
    saveDocument(true);
  });
  $('optSaveDirect') && $('optSaveDirect').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.add('hidden');
    saveDocument(false);
  });
  $('optSaveAs') && $('optSaveAs').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.add('hidden');
    saveDocument(true);
  });
  $('btnExportModalClose') && $('btnExportModalClose').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.add('hidden');
  });
  $('btnSave') && $('btnSave').addEventListener('click', () => saveDocument(false));
  $('btnDocInfoExport') && $('btnDocInfoExport').addEventListener('click', () => saveDocument(false));
  $('btnDocInfoExportAs') && $('btnDocInfoExportAs').addEventListener('click', () => saveDocument(true));

  // Drag and Drop File Handlers
  window.addEventListener('dragover', e => {
    e.preventDefault();
    if ($('welcomeDropzone')) $('welcomeDropzone').classList.remove('hidden');
    const card = document.querySelector('.welcome-card');
    if (card) card.classList.add('drag-over');
  });

  window.addEventListener('dragleave', e => {
    if (e.clientX <= 0 || e.clientY <= 0 || e.relatedTarget === null) {
      const card = document.querySelector('.welcome-card');
      if (card) card.classList.remove('drag-over');
      if (state.pageInfos && state.pageInfos.length > 0) {
        if ($('welcomeDropzone')) $('welcomeDropzone').classList.add('hidden');
      }
    }
  });

  window.addEventListener('drop', async e => {
    e.preventDefault();
    const card = document.querySelector('.welcome-card');
    if (card) card.classList.remove('drag-over');
    const files = e.dataTransfer && e.dataTransfer.files;
    const file = files && files[0];
    if (file && (file.type === 'application/pdf' || file.name.endsWith('.pdf'))) {
      try {
        const invoke = getInvoke();
        const filePath = file.path || file.webkitRelativePath;
        if (filePath && invoke) {
          const r = await invoke('open_pdf', { pathStr: filePath });
          handlePdfLoadSuccess(file.name, filePath, r.page_infos || [], r.recovered_strokes || 0, r.loaded_strokes || [], r.outline || []);
          return;
        }
        const arrayBuf = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(arrayBuf));
        if (invoke) {
          const r2 = await invoke('open_pdf_bytes', { name: file.name, bytes });
          handlePdfLoadSuccess(file.name, null, r2.page_infos || [], r2.recovered_strokes || 0, r2.loaded_strokes || [], r2.outline || []);
        }
      } catch (err) {
        console.error('[inkwell] Drop error:', err);
        showToast('Failed to load dropped PDF: ' + (err.message || err), 'error');
      }
    }
  });

// Window blur safety cleanup to prevent stuck drawing / panning states
window.addEventListener('blur', () => {
  if (viewport) {
    viewport.isPanning = false;
  }
  state.isErasing = false;
  state.spacePanActive = false;
  state.cur = null;
  state.streamline = null;
  clearLaser();
  clearWet();
  if (wetCanvas) {
    wetCanvas.classList.remove('panning', 'space-pan');
  }
  $('toolbar') && $('toolbar').classList.remove('pen-down');
  $('floatingDock') && $('floatingDock').classList.remove('pen-down');
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
  item.addEventListener('mouseenter', () => {
    const label = $('radialLabel');
    if (label) {
      const tip = item.querySelector('.tip');
      if (tip) label.textContent = tip.textContent;
    }
  });
  item.addEventListener('mouseleave', () => {
    const label = $('radialLabel');
    if (label) {
      label.textContent = state.activeTool.charAt(0).toUpperCase() + state.activeTool.slice(1);
    }
  });
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
  if (!e.target.closest('#propPopover') && !e.target.closest('#btnProp') && !e.target.closest('#btnDockAddPreset')) {
    $('propPopover') && $('propPopover').classList.add('hidden');
  }
});

// ---- Zoom Navigation Helpers & Presets ----
function zoomIn() {
  if (!viewport) return;
  const pane = (viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
  const curZoom = pane === 'right' ? viewport.rightZoom : viewport.zoom;
  const stageRect = viewport.stageRect || ($('stage') ? $('stage').getBoundingClientRect() : { width: 800, height: 600 });
  const center = [stageRect.width / 2, stageRect.height / 2];
  viewport.setZoom(Math.min(10.0, curZoom * 1.25), center, pane);
  updateZoomUI();
}

function zoomOut() {
  if (!viewport) return;
  const pane = (viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
  const curZoom = pane === 'right' ? viewport.rightZoom : viewport.zoom;
  const stageRect = viewport.stageRect || ($('stage') ? $('stage').getBoundingClientRect() : { width: 800, height: 600 });
  const center = [stageRect.width / 2, stageRect.height / 2];
  viewport.setZoom(Math.max(0.15, curZoom / 1.25), center, pane);
  updateZoomUI();
}

function zoomFit() {
  if (!viewport) return;
  const pane = (viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
  const pi = state.pageInfos ? state.pageInfos[state.leftSheet] : null;
  if (pi) {
    fitPageInPanes(pi);
  } else {
    viewport.fitPage(595, 842, pane);
  }
  scheduleRedrawTiles();
  redrawAll();
  updateZoomUI();
}

function zoomActual() {
  if (!viewport) return;
  const pane = (viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
  const stageRect = viewport.stageRect || ($('stage') ? $('stage').getBoundingClientRect() : { width: 800, height: 600 });
  const center = [stageRect.width / 2, stageRect.height / 2];
  viewport.setZoom(1.0, center, pane);
  updateZoomUI();
}

function zoomFitWidth() {
  if (!viewport) return;
  const pane = (viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
  const pi = state.pageInfos ? state.pageInfos[state.leftSheet] : null;
  const w = pi ? (pi.width_pt || pi.width) : 595;
  viewport.fitWidth(w, pane);
  updateZoomUI();
}

function updateZoomUI() {
  if (!viewport) return;
  const pane = (viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
  const curZoom = pane === 'right' ? viewport.rightZoom : viewport.zoom;
  const pct = Math.round(curZoom * 100);
  if ($('zoomLevelDisplay')) $('zoomLevelDisplay').textContent = `${pct}%`;
  document.querySelectorAll('.zoom-menu-item').forEach(item => {
    const dataZoom = item.getAttribute('data-zoom');
    if (dataZoom && !isNaN(parseFloat(dataZoom))) {
      const targetPct = Math.round(parseFloat(dataZoom) * 100);
      item.classList.toggle('active', Math.abs(targetPct - pct) < 3);
    }
  });
}

// Touch gesture cancellation helper for multi-touch pinch/pan
window.cancelPendingTouchStroke = () => {
  if (state.cur) {
    state.cur = null;
    state.streamline = null;
    clearWet();
  }
  if (wetCanvas && typeof wetCanvas.hasPointerCapture === 'function' && viewport && viewport.activeTouches) {
    for (const pid of viewport.activeTouches.keys()) {
      try {
        if (wetCanvas.hasPointerCapture(pid)) {
          wetCanvas.releasePointerCapture(pid);
        }
      } catch (_) {}
    }
  }
};

window.addEventListener('click', e => {
  if (!e.target.closest('#radialMenu')) hideRadialMenu();
  if (!e.target.closest('#propPopover') && !e.target.closest('#btnProp') && !e.target.closest('#btnDockAddPreset')) {
    $('propPopover') && $('propPopover').classList.add('hidden');
  }
});

// Keyboard shortcuts
window.addEventListener('keydown', e => {
  const modal = $('cmdPaletteModal');
  if (modal && !modal.classList.contains('hidden')) {
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

  // Hierarchical Escape key handling
  if (e.key === 'Escape') {
    // 1. Zoom menu popover
    const zoomPopover = $('zoomMenuPopover');
    if (zoomPopover && !zoomPopover.classList.contains('hidden')) {
      zoomPopover.classList.add('hidden');
      return;
    }
    // 2. Properties popover
    const propPopover = $('propPopover');
    if (propPopover && !propPopover.classList.contains('hidden')) {
      propPopover.classList.add('hidden');
      return;
    }
    // 3. Radial menu
    const radial = $('radialMenu');
    if (radial && !radial.classList.contains('hidden')) {
      radial.classList.add('hidden');
      return;
    }
    // 4. Context menu
    const ctxMenu = $('canvasContextMenu');
    if (ctxMenu && !ctxMenu.classList.contains('hidden')) {
      ctxMenu.classList.add('hidden');
      return;
    }
    // 5. Text selection popover
    const textSel = $('textSelectionPopover');
    if (textSel && !textSel.classList.contains('hidden')) {
      textSel.classList.add('hidden');
      return;
    }
    // 6. Inline text editor
    const inlineEditor = $('inlineTextEditor');
    if (inlineEditor && !inlineEditor.classList.contains('hidden')) {
      commitInlineTextEditor();
      return;
    }
    // 7. Open Modals
    const modals = [
      $('settingsModal'),
      $('exportModal'),
      $('insertPageModal'),
      $('goToPageModal'),
      $('shortcutsModal'),
      $('confirmCloseModal'),
      $('cmdPaletteModal')
    ];
    for (const m of modals) {
      if (m && !m.classList.contains('hidden')) {
        m.classList.add('hidden');
        return;
      }
    }
    const sideDrawer = $('sideDrawer');
    if (sideDrawer && !sideDrawer.classList.contains('hidden')) {
      sideDrawer.classList.add('hidden');
      return;
    }
    // 8. Clear Selection if any
    if ((state.selectedStrokes && state.selectedStrokes.length) || (state.selectedImages && state.selectedImages.length)) {
      clearSelection();
      redrawAll();
      return;
    }
  }

  // If user is currently typing in an input or textarea, don't hijack editing keys
  const activeEl = document.activeElement;
  const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');

  if (!isTyping) {
    const targetPane = (viewport && viewport.splitMode && state.activePane === 'right') ? 'right' : 'left';
    const curSheet = targetPane === 'right' ? state.rightSheet : state.leftSheet;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === '[') {
      e.preventDefault();
      goToPage(curSheet - 1, targetPane);
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ']') {
      e.preventDefault();
      goToPage(curSheet + 1, targetPane);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      goToPage(0, targetPane);
      return;
    }
    if (e.key === 'End' && state.pageInfos && state.pageInfos.length) {
      e.preventDefault();
      goToPage(state.pageInfos.length - 1, targetPane);
      return;
    }
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!isTyping && ((state.selectedStrokes && state.selectedStrokes.length) || (state.selectedImages && state.selectedImages.length))) {
      e.preventDefault();
      deleteSelection();
      return;
    }
  }

  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || (e.shiftKey && e.key.toLowerCase() === 'p'))) {
    e.preventDefault();
    openCommandPalette();
    return;
  }

  // Universal Ctrl / Cmd modified shortcuts
  if (e.ctrlKey || e.metaKey) {
    // Zoom shortcuts
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
      e.preventDefault();
      zoomIn();
      return;
    }
    if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      zoomOut();
      return;
    }
    if (e.key === '0' || e.code === 'Numpad0') {
      e.preventDefault();
      zoomFit();
      return;
    }
    if (e.key === '1' || e.code === 'Numpad1') {
      e.preventDefault();
      zoomActual();
      return;
    }
    if (e.key === '2' || e.code === 'Numpad2') {
      e.preventDefault();
      zoomFitWidth();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (state.tabs && state.tabs.length > 1) {
        const curIdx = state.tabs.findIndex(t => t.id === state.activeTabId);
        const nextIdx = (curIdx + 1) % state.tabs.length;
        switchTab(state.tabs[nextIdx].id);
      }
      return;
    }
    if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      closeTab(state.activeTabId);
      return;
    }
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      selectAllOnCurrentPage();
      return;
    }
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      copySelection();
      return;
    }
    if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      cutSelection();
      return;
    }
    if (e.key === 'v' || e.key === 'V') {
      if (pasteClipboard()) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      duplicateSelection();
      return;
    }
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      if (e.shiftKey) openInsertPageModal();
      else createBlankWhiteboard();
      return;
    }
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.key === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 's') { e.preventDefault(); saveDocument(false); return; }
    if (e.key === 'o') { e.preventDefault(); $('btnHeaderOpen') && $('btnHeaderOpen').click(); return; }
    if (e.key === 'b') { e.preventDefault(); toggleSidebar(); return; }
    if (e.key === 'g' || e.key === 'G') { e.preventDefault(); openGoToPageModal(); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleDrawer('search'); return; }
    if (e.key === ',') { e.preventDefault(); openSettingsModal(); return; }
    return;
  }

  if (e.altKey) return;
  if (e.repeat) return;
  if (isTyping) return;

  const k = e.key.toLowerCase();
  if (e.key === '?' || e.key === 'F1') {
    e.preventDefault();
    openShortcutsModal();
    return;
  }

  const DIRECT_TOOL_MAP = {
    p: 'pen',
    m: 'highlighter',
    h: 'pan',
    e: 'eraser',
    v: 'lasso',
    l: 'laser',
    u: 'rect',
    q: 'rect',
    r: 'ruler',
    o: 'ellipse',
    t: 'text',
  };

  if (DIRECT_TOOL_MAP[k]) {
    e.preventDefault();
    setTool(DIRECT_TOOL_MAP[k]);
    return;
  }
  if (k === 'c') {
    e.preventDefault();
    $('propPopover') && $('propPopover').classList.toggle('hidden');
    return;
  }
  if (k === 's') {
    e.preventDefault();
    openSettingsModal();
    return;
  }
});

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
    $('toolbar') && $('toolbar').classList.remove('pen-down');
  });
}

async function restoreSessionState() {
  try {
    const isRestoreEnabled = localStorage.getItem('inkwell_restore_session_enabled') === 'true';
    if (!isRestoreEnabled) {
      setWelcomeState(true);
      return;
    }
    const raw = localStorage.getItem('inkwell_open_tabs');
    if (!raw) {
      setWelcomeState(true);
      return;
    }
    const sessionData = JSON.parse(raw);
    if (!sessionData || !Array.isArray(sessionData.tabs) || !sessionData.tabs.length) {
      setWelcomeState(true);
      return;
    }
    const invoke = getInvoke();
    if (!invoke) {
      setWelcomeState(true);
      return;
    }

    let loadedAny = false;
    for (const t of sessionData.tabs) {
      if (t.pathStr) {
        try {
          const r = await invoke('open_pdf', { pathStr: t.pathStr });
          if (r && r.page_infos) {
            handlePdfLoadSuccess(t.title || 'Document.pdf', t.pathStr, r.page_infos, r.recovered_strokes || 0, r.loaded_strokes || [], r.outline || []);
            loadedAny = true;
          }
        } catch (e) {
          console.warn('[inkwell] Failed to restore session tab:', t.pathStr, e);
        }
      }
    }
    if (!loadedAny) {
      setWelcomeState(true);
    }
  } catch (err) {
    console.warn('[inkwell] restoreSessionState error:', err);
    setWelcomeState(true);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  tilesCanvas = $('tiles');
  dryCanvas = $('dry');
  wetCanvas = $('wet');

  viewport = new ViewportManager(() => {
    syncActivePagesFromViewport();
    scheduleRedrawTiles();
    scheduleRedrawAll();
    updateZoomUI();
    updateDocScrollbar();
  });
  viewport.attachListeners($('stage'));

  // Create canvas backing stores and contexts
  resize();

  // Initialize in clean Welcome Mode
  setWelcomeState(true);
  renderRecentFiles();

  attachPointerHandlers();
  bindUI();
  attachOpenListeners();
  initDocScrollbar();
  initContextMenu();
  initSelectionToolbar();
  initTextSelectionActions();
  initInlineTextEditor();
  window.addEventListener('paste', handleGlobalPaste);

  setTool(state.activeTool);
  updatePageUI();

  window.addEventListener('resize', resize);
  window.addEventListener('scroll', updateStageRect, { passive: true });

  const drawer = $('navDrawer');
  if (drawer) {
    drawer.addEventListener('transitionend', onDrawerLayoutChange);
    drawer.addEventListener('transitionstart', onDrawerLayoutChange);
  }

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      onDrawerLayoutChange();
    });
    const stageEl = $('stage');
    if (stageEl) ro.observe(stageEl);
    const mainEl = $('mainContent');
    if (mainEl) ro.observe(mainEl);
  }

  restoreSessionState();

  window.undo = undo;
  window.redo = redo;
  window.zoomIn = zoomIn;
  window.zoomOut = zoomOut;
  window.zoomFit = zoomFit;
  window.zoomActual = zoomActual;
  window.zoomFitWidth = zoomFitWidth;
  window.showToast = showToast;
  window.scheduleRedrawTiles = scheduleRedrawTiles;
  window.scheduleRedrawAll = scheduleRedrawAll;
  window.redrawAll = redrawAll;
});
