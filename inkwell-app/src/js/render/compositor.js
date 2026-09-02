/* ============================================================================
 * render/compositor.js — Multi-Canvas Pipeline Compositor for Inkwell
 * Coordinates the triple-canvas pipeline: Tiles (LOD) -> Dry (Committed) -> Wet (Active Inking).
 * Reads document state; never mutates document state.
 * ========================================================================== */

import { state } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as templates from './templates.js';
import * as tiles from './tiles.js';
import * as overlays from './overlays.js';

let _tilesCanvas, _dryCanvas, _wetCanvas;
let _tctx, _dctx, _wctx;
let _viewport = null;
let _stageRect = null;

let _redrawTilesPending = false;
let _redrawAllPending = false;
let _redrawTilesEpoch = 0;

export function initCompositor({ tilesCanvas, dryCanvas, wetCanvas, viewport }) {
  _tilesCanvas = tilesCanvas;
  _dryCanvas = dryCanvas;
  _wetCanvas = wetCanvas;
  _viewport = viewport;

  _tctx = makeCtx(_tilesCanvas);
  _dctx = makeCtx(_dryCanvas);
  _wctx = makeCtx(_wetCanvas);
}

export function getCanvases() {
  return { tilesCanvas: _tilesCanvas, dryCanvas: _dryCanvas, wetCanvas: _wetCanvas };
}

export function getContexts() {
  return { tctx: _tctx, dctx: _dctx, wctx: _wctx };
}

export function makeCtx(canvas) {
  if (!canvas) return null;
  return canvas.getContext('2d', { desynchronized: true, alpha: true });
}

export function updateStageRect() {
  if (_wetCanvas) {
    _stageRect = _wetCanvas.getBoundingClientRect();
  }
  if (_viewport && _viewport.updateStageRect) {
    _viewport.updateStageRect();
  }
}

export function getStageRect() {
  return _stageRect;
}

export function paneBounds(pane = 'left') {
  if (!_tilesCanvas) return { x: 0, y: 0, width: 800, height: 600 };
  const width = _tilesCanvas.width / state.dpr;
  const height = _tilesCanvas.height / state.dpr;
  if (!_viewport || !_viewport.splitMode) return { x: 0, y: 0, width, height };
  const half = width / 2;
  return pane === 'right' ? { x: half, y: 0, width: half, height } : { x: 0, y: 0, width: half, height };
}

export function visiblePanes() {
  return _viewport && _viewport.splitMode ? ['left', 'right'] : ['left'];
}

export function paneForEvent(e) {
  const r = _stageRect || (_wetCanvas ? (_stageRect = _wetCanvas.getBoundingClientRect()) : { left: 0, width: window.innerWidth });
  return _viewport && _viewport.splitMode && (e.clientX - r.left > r.width / 2) ? 'right' : 'left';
}

export function paneTransform(ctx, pane = 'left') {
  if (!ctx || !_viewport) return;
  const isRight = pane === 'right' && _viewport.splitMode;
  ctx.translate(isRight ? _viewport.rightPanX : _viewport.panX, isRight ? _viewport.rightPanY : _viewport.panY);
  ctx.scale(isRight ? _viewport.rightZoom : _viewport.zoom, isRight ? _viewport.rightZoom : _viewport.zoom);
}

export function clipToPane(ctx, pane = 'left') {
  if (!ctx) return;
  const bounds = paneBounds(pane);
  ctx.beginPath();
  ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.clip();
}

export function resize() {
  updateStageRect();
  const r = _stageRect;
  if (!r || r.width <= 0 || r.height <= 0) return;
  state.dpr = Math.max(1, window.devicePixelRatio || 1);

  for (const c of [_tilesCanvas, _dryCanvas, _wetCanvas]) {
    if (!c) continue;
    c.width = Math.round(r.width * state.dpr);
    c.height = Math.round(r.height * state.dpr);
    c.style.width = r.width + 'px';
    c.style.height = r.height + 'px';
  }

  _tctx = makeCtx(_tilesCanvas);
  _dctx = makeCtx(_dryCanvas);
  _wctx = makeCtx(_wetCanvas);

  for (const ctx of [_tctx, _dctx, _wctx]) {
    if (ctx) ctx.scale(state.dpr, state.dpr);
  }

  scheduleRedrawTiles();
  redrawAll();
}

export function scheduleRedrawTiles() {
  if (_redrawTilesPending) return;
  _redrawTilesPending = true;
  requestAnimationFrame(() => {
    _redrawTilesPending = false;
    redrawTiles();
  });
}

export async function redrawTiles() {
  if (!_tctx || !_tilesCanvas || !_viewport) return;
  const drawEpoch = ++_redrawTilesEpoch;
  _tctx.setTransform(1, 0, 0, 1, 0, 0);
  _tctx.clearRect(0, 0, _tilesCanvas.width, _tilesCanvas.height);

  for (const pane of visiblePanes()) {
    const visiblePages = _viewport.getVisiblePages(pane);
    for (const pl of visiblePages) {
      const pi = state.pageInfos && state.pageInfos[pl.sheet];
      templates.drawPageBackground(_tctx, pl, _viewport, pi, state.dpr, pane);
    }
    if (visiblePages.length) {
      const bounds = paneBounds(pane);
      await Promise.all(visiblePages.map(pl => {
        const pi = state.pageInfos[pl.sheet];
        return pi ? tiles.redrawTilesForPage(_tctx, pane, pi, pl, _viewport, state.dpr, bounds, clipToPane) : Promise.resolve();
      }));
    }
  }

  overlays.drawZoomIndicator(_tctx, _viewport, state.dpr, visiblePanes(), paneBounds);
  tiles.evictTileCache();
}

export function scheduleRedrawAll() {
  if (_redrawAllPending) return;
  _redrawAllPending = true;
  requestAnimationFrame(() => {
    _redrawAllPending = false;
    redrawAll();
  });
}

export function redrawAll() {
  if (!_dctx || !_dryCanvas || !_viewport) return;
  _dctx.setTransform(1, 0, 0, 1, 0, 0);
  _dctx.clearRect(0, 0, _dryCanvas.width, _dryCanvas.height);
  _dctx.scale(state.dpr, state.dpr);

  if (!state.cur) {
    clearWet();
  }

  if (!state.inkVisible) return;

  for (const pane of visiblePanes()) {
    const visiblePages = _viewport.getVisiblePages(pane);
    _dctx.save();
    clipToPane(_dctx, pane);

    for (const pl of visiblePages) {
      _dctx.save();
      const [psx, psy] = _viewport.worldToScreen(pl.x, pl.y, pane);
      const z = pane === 'right' && _viewport.splitMode ? _viewport.rightZoom : _viewport.zoom;
      _dctx.translate(psx, psy);
      _dctx.scale(z, z);

      // 0. Page template guidelines
      const pi = state.pageInfos && state.pageInfos[pl.sheet];
      if (pi && pi.template && pi.template !== 'blank') {
        templates.drawPageTemplateGuidelines(_dctx, pi.template, pl.width, pl.height);
      }

      // 1. Embedded images
      if (state.images && state.images.length) {
        for (const img of state.images) {
          if (!img.deleted && img.sheet === pl.sheet && img._el) {
            try {
              _dctx.drawImage(img._el, img.x, img.y, img.width, img.height);
            } catch (_) {}
          }
        }
      }

      // 2. Direct in-place text objects
      if (state.textObjects && state.textObjects.length) {
        for (const t of state.textObjects) {
          if (!t.deleted && t.sheet === pl.sheet && t.text) {
            _dctx.save();
            _dctx.fillStyle = t.color || '#141724';
            const weight = t.bold ? 'bold ' : '';
            const slant = t.italic ? 'italic ' : '';
            const size = t.fontSize || 16;
            _dctx.font = `${slant}${weight}${size}px Inter, system-ui, -apple-system, sans-serif`;
            _dctx.textBaseline = 'top';
            const lines = (t.text || '').split('\n');
            const lineHeight = size * 1.35;
            lines.forEach((line, idx) => {
              _dctx.fillText(line, t.x, t.y + idx * lineHeight);
            });
            _dctx.restore();
          }
        }
      }

      // 3. Vector ink strokes with sheet indexing and bbox culling
      if (window.Ink && typeof window.Ink.drawStroke === 'function') {
        const sheetStrokes = documentOps.getStrokesForSheet(pl.sheet);
        const pageW = pl.width;
        const pageH = pl.height;
        for (const s of sheetStrokes) {
          if (s.deleted) continue;
          if (s.bbox) {
            const margin = s.base_width || 4;
            if (
              s.bbox[2] < -margin ||
              s.bbox[0] > pageW + margin ||
              s.bbox[3] < -margin ||
              s.bbox[1] > pageH + margin
            ) {
              continue; // Bbox lies completely outside visible page bounds
            }
          }
          window.Ink.drawStroke(_dctx, s);
        }
      }

      _dctx.restore();
    }
    _dctx.restore();
  }

  // 4. Persistent text selection and search highlights
  overlays.drawPersistentTextSelectionHighlights(_dctx, state, _viewport, state.dpr, visiblePanes(), clipToPane);
  overlays.drawSearchHighlights(_dctx, state, _viewport, state.dpr, visiblePanes(), clipToPane);

  // Draw selection / lasso overlay on wet layer
  overlays.drawSelectionOverlay(_wctx, state, _viewport, state.dpr, state.drawingPane || 'left');
}

export function drawCommittedStroke(stroke) {
  if (!_dctx || !_viewport || !stroke) return;
  const pl = _viewport.getPageLayout(stroke.sheet || 0);
  for (const pane of visiblePanes()) {
    _dctx.save();
    _dctx.setTransform(1, 0, 0, 1, 0, 0);
    _dctx.scale(state.dpr, state.dpr);
    clipToPane(_dctx, pane);
    const [psx, psy] = _viewport.worldToScreen(pl.x, pl.y, pane);
    const z = pane === 'right' && _viewport.splitMode ? _viewport.rightZoom : _viewport.zoom;
    _dctx.translate(psx, psy);
    _dctx.scale(z, z);
    if (window.Ink && typeof window.Ink.drawStroke === 'function') {
      window.Ink.drawStroke(_dctx, stroke);
    }
    _dctx.restore();
  }
}

export function clearWet() {
  if (!_wctx || !_wetCanvas) return;
  _wctx.setTransform(1, 0, 0, 1, 0, 0);
  _wctx.clearRect(0, 0, _wetCanvas.width, _wetCanvas.height);
  _wctx.scale(state.dpr, state.dpr);
}
