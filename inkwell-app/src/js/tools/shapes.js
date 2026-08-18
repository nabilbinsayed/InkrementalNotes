/* ============================================================================
 * tools/shapes.js — Geometric Shapes Tool Adapter for Inkwell
 * Generates exact vector rectangles, ellipses, and ruler lines without curve distortion.
 * ========================================================================== */

import { state } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';
import * as overlays from '../render/overlays.js';

export function onShapeDown(e, ptWorld, pane, viewport) {
  state.shapeStart = [ptWorld[0], ptWorld[1]];
  state.shapeEnd = [ptWorld[0], ptWorld[1]];
  state.drawingPane = pane;
}

export function onShapeMove(e, ptWorld, pane, viewport) {
  if (!state.shapeStart) return;
  state.shapeEnd = [ptWorld[0], ptWorld[1]];
  
  compositor.clearWet();
  const { wctx } = compositor.getContexts();
  if (wctx) {
    overlays.drawShapeOverlay(wctx, state, viewport, state.dpr, pane, compositor.clipToPane);
  }
}

export function onShapeUp(e, viewport) {
  if (!state.shapeStart || !state.shapeEnd) return;
  const start = state.shapeStart;
  const end = state.shapeEnd;
  state.shapeStart = null;
  state.shapeEnd = null;

  const pageCoord = viewport.worldToPage(start[0], start[1]);
  const activeSheet = pageCoord.sheet;
  const pl = viewport.getPageLayout(activeSheet);

  const px0 = start[0] - pl.x;
  const py0 = start[1] - pl.y;
  const px1 = end[0] - pl.x;
  const py1 = end[1] - pl.y;

  const dx = px1 - px0;
  const dy = py1 - py0;
  if (Math.hypot(dx, dy) < 4) {
    compositor.clearWet();
    return;
  }

  const kind = state.shapeKind || 'rect';
  const points = [];

  if (kind === 'rect') {
    // 4 corners of rectangle with high sample density for sharp corners
    const samples = 40;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      if (t <= 0.25) {
        const u = t / 0.25;
        points.push({ x: px0 + u * dx, y: py0, p: 0.8, w: state.baseWidth });
      } else if (t <= 0.5) {
        const u = (t - 0.25) / 0.25;
        points.push({ x: px1, y: py0 + u * dy, p: 0.8, w: state.baseWidth });
      } else if (t <= 0.75) {
        const u = (t - 0.5) / 0.25;
        points.push({ x: px1 - u * dx, y: py1, p: 0.8, w: state.baseWidth });
      } else {
        const u = (t - 0.75) / 0.25;
        points.push({ x: px0, y: py1 - u * dy, p: 0.8, w: state.baseWidth });
      }
    }
  } else if (kind === 'ellipse') {
    const cx = (px0 + px1) / 2;
    const cy = (py0 + py1) / 2;
    const rx = Math.abs(dx) / 2;
    const ry = Math.abs(dy) / 2;
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2;
      points.push({
        x: cx + rx * Math.cos(theta),
        y: cy + ry * Math.sin(theta),
        p: 0.8,
        w: state.baseWidth,
      });
    }
  } else if (kind === 'line') {
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push({
        x: px0 + t * dx,
        y: py0 + t * dy,
        p: 0.8,
        w: state.baseWidth,
      });
    }
  }

  const stroke = {
    id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    kind: 'pen',
    rgb: state.color || [0.08, 0.09, 0.14],
    base_width: state.baseWidth || 1.6,
    sheet: activeSheet,
    points,
    deleted: false,
  };

  if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
    stroke.bbox = window.Ink.computeStrokeBbox(points, stroke.base_width);
  }
  if (window.Ink && typeof window.Ink.getPath2D === 'function') {
    stroke._cachedPath2D = window.Ink.getPath2D(stroke);
  }

  documentOps.addStroke(stroke, { recordHistory: true });
  ipc.commitStroke(stroke.sheet, stroke.kind, stroke.rgb, stroke.base_width, stroke.points)
    .catch(() => {});

  compositor.clearWet();
  compositor.redrawAll();
}
