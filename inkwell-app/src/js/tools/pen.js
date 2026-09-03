/* ============================================================================
 * tools/pen.js — Fountain Pen & Chisel Highlighter Interaction Adapter
 * Captures low-latency pointer input, applies One-Euro/Streamline filtering,
 * paints to the wet canvas, and commits vector strokes to the document.
 * ========================================================================== */

import { state, warnDurability } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';

export function onPenDown(e, ptWorld, pane, viewport) {
  const isHighlighter = state.activeTool === 'highlighter';
  const pageCoord = viewport.worldToPage(ptWorld[0], ptWorld[1]);
  const activeSheet = pageCoord.sheet;

  const baseW = state.baseWidth || (isHighlighter ? 16.0 : 1.6);
  if (window.Ink && typeof window.Ink.Stroke === 'function') {
    state.cur = new window.Ink.Stroke({
      kind: isHighlighter ? 'highlighter' : 'pen',
      rgb: state.color,
      baseWidth: baseW,
    });
  } else {
    state.cur = {
      id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      kind: isHighlighter ? 'highlighter' : 'pen',
      rgb: state.color,
      base_width: baseW,
      points: [],
    };
  }
  state.cur.base_width = baseW;
  state.cur.sheet = activeSheet;
  state.drawingPane = pane;
  if (window.Ink && typeof window.Ink.Streamline === 'function') {
    state.streamline = new window.Ink.Streamline(0.45, 0.35);
  }

  consumeSample(e, ptWorld, pane, viewport);
}

export function onPenMove(e, ptWorld, pane, viewport) {
  if (!state.cur) return;
  consumeSample(e, ptWorld, pane, viewport);
}

export function onPenUp(e, viewport) {
  if (!state.cur) return;
  const stroke = state.cur;
  state.cur = null;
  state.streamline = null;

  if (stroke.points && stroke.points.length > 0) {
    if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
      stroke.bbox = window.Ink.computeStrokeBbox(stroke.points, stroke.base_width);
    }
    if (window.Ink && typeof window.Ink.getPath2D === 'function') {
      stroke._cachedPath2D = window.Ink.getPath2D(stroke);
    }

    // Add to authoritative document state and record history transaction
    documentOps.addStroke(stroke, { recordHistory: true });

    // Asynchronous WAL journal commit
    ipc.commitStroke(stroke.sheet, stroke.kind, stroke.rgb, stroke.base_width, stroke.points, stroke.id)
      .then(serverId => { if (serverId) stroke.id = String(serverId); })
      .catch(err => {
        console.warn('[inkwell/pen] commitStroke WAL error:', err);
        warnDurability('Stroke may not persist: ' + err);
      });
  }

  compositor.clearWet();
  compositor.redrawAll();
}

export function onPenCancel() {
  state.cur = null;
  state.streamline = null;
  compositor.clearWet();
}

function consumeSample(e, ptWorld, pane, viewport) {
  if (!state.cur || !viewport) return;
  const pageCoord = viewport.worldToPage(ptWorld[0], ptWorld[1]);
  const px = pageCoord.px;
  const py = pageCoord.py;
  let p = typeof window.resolvePressure === 'function'
    ? window.resolvePressure(e)
    : (e.pressure !== undefined && e.pressure > 0 ? e.pressure : 0.5);
  const t = e.timeStamp || performance.now();

  if (state.streamline) {
    const smoothed = state.streamline.filter(px, py, p);
    consumeFilteredPoint(smoothed.x, smoothed.y, smoothed.p, t, pane, viewport);
  } else {
    consumeFilteredPoint(px, py, p, t, pane, viewport);
  }
}

function consumeFilteredPoint(px, py, p, t, pane, viewport) {
  const { wctx } = compositor.getContexts();
  if (!wctx || !state.cur) return;

  const isHighlighter = state.cur.kind === 'highlighter';
  let pt;
  if (typeof state.cur.push === 'function') {
    pt = state.cur.push(px, py, p, t);
    if (!pt) return; // Deduplicated jitter
  } else {
    const baseW = state.cur.base_width || state.cur.baseWidth || state.baseWidth || 1.6;
    const c = Math.pow(Math.max(0, Math.min(1, p)), 1.0);
    const w = isHighlighter ? baseW : baseW * (0.22 + 0.78 * c);
    pt = { x: px, y: py, p, w, t };
    if (!state.cur.points) state.cur.points = [];
    state.cur.points.push(pt);
  }

  const pl = viewport.getPageLayout(state.cur.sheet || 0);
  const [psx, psy] = viewport.worldToScreen(pl.x, pl.y, pane);
  const z = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;

  wctx.save();
  compositor.clipToPane(wctx, pane);
  wctx.translate(psx, psy);
  wctx.scale(z, z);

  const prev = state.cur.points.length > 1 ? state.cur.points[state.cur.points.length - 2] : null;

  if (isHighlighter) {
    wctx.globalCompositeOperation = 'multiply';
    wctx.globalAlpha = 0.42;
  }
  wctx.fillStyle = state.cur.cssColor || `rgb(${state.cur.rgb.map(v => Math.round(v * 255)).join(',')})`;

  if (window.Ink && typeof window.Ink.drawSegment === 'function') {
    if (prev) {
      window.Ink.drawSegment(wctx, prev, pt);
    } else {
      window.Ink.drawDot(wctx, pt);
    }
  } else {
    // Fallback line rendering
    wctx.strokeStyle = wctx.fillStyle;
    wctx.lineWidth = (state.cur.base_width || 1.6) * p;
    wctx.lineCap = 'round';
    wctx.beginPath();
    if (!prev) {
      wctx.arc(px, py, wctx.lineWidth / 2, 0, Math.PI * 2);
      wctx.fill();
    } else {
      wctx.moveTo(prev.x, prev.y);
      wctx.lineTo(px, py);
      wctx.stroke();
    }
  }

  wctx.restore();
}
