/* ============================================================================
 * tools/pen.js — Fountain Pen & Chisel Highlighter Interaction Adapter
 * Captures low-latency pointer input, applies One-Euro/Streamline filtering,
 * paints to the wet canvas, and commits vector strokes to the document.
 * ========================================================================== */

import { state } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';

export function onPenDown(e, ptWorld, pane, viewport) {
  const isHighlighter = state.activeTool === 'highlighter';
  const pageCoord = viewport.worldToPage(ptWorld[0], ptWorld[1]);
  const activeSheet = pageCoord.sheet;

  if (window.Ink && typeof window.Ink.Stroke === 'function') {
    state.cur = new window.Ink.Stroke({
      kind: isHighlighter ? 'highlighter' : 'pen',
      rgb: state.color,
      baseWidth: state.baseWidth,
    });
  } else {
    state.cur = {
      id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      kind: isHighlighter ? 'highlighter' : 'pen',
      rgb: state.color,
      base_width: state.baseWidth,
      points: [],
    };
  }

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
    ipc.commitStroke(stroke.sheet, stroke.kind, stroke.rgb, stroke.base_width, stroke.points)
      .catch(err => console.warn('[inkwell/pen] commitStroke WAL error:', err));
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
  let p = e.pressure !== undefined && e.pressure > 0 ? e.pressure : 0.5;
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

  const pt = { x: px, y: py, p, t };
  if (!state.cur.points) state.cur.points = [];
  state.cur.points.push(pt);

  const pl = viewport.getPageLayout(state.cur.sheet || 0);
  const [psx, psy] = viewport.worldToScreen(pl.x, pl.y, pane);
  const z = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;

  wctx.save();
  compositor.clipToPane(wctx, pane);
  wctx.translate(psx, psy);
  wctx.scale(z, z);

  if (window.Ink && typeof window.Ink.drawStroke === 'function') {
    window.Ink.drawStroke(wctx, state.cur);
  } else {
    // Fallback line rendering
    wctx.strokeStyle = `rgb(${state.cur.rgb.map(v => Math.round(v * 255)).join(',')})`;
    wctx.lineWidth = (state.cur.base_width || 1.6) * p;
    wctx.lineCap = 'round';
    wctx.beginPath();
    if (state.cur.points.length === 1) {
      wctx.arc(px, py, wctx.lineWidth / 2, 0, Math.PI * 2);
      wctx.fill();
    } else {
      const prev = state.cur.points[state.cur.points.length - 2];
      wctx.moveTo(prev.x, prev.y);
      wctx.lineTo(px, py);
      wctx.stroke();
    }
  }

  wctx.restore();
}
