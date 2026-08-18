/* ============================================================================
 * tools/eraser.js — Precision Stroke Eraser Adapter for Inkwell
 * Performs proximity hit-testing across visible pages and deletes strokes.
 * ========================================================================== */

import { state } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';

export function onEraserDown(e, ptWorld, pane, viewport) {
  state.isErasing = true;
  eraseStrokesAt(ptWorld, pane, viewport);
}

export function onEraserMove(e, ptWorld, pane, viewport) {
  if (!state.isErasing) return;
  eraseStrokesAt(ptWorld, pane, viewport);
}

export function onEraserUp() {
  state.isErasing = false;
}

export function eraseStrokesAt(ptWorld, pane, viewport) {
  if (!state.strokes || !state.strokes.length || !viewport) return;
  const wx = ptWorld[0];
  const wy = ptWorld[1];

  const z = (pane === 'right' && viewport.splitMode) ? viewport.rightZoom : viewport.zoom;
  const radius = Math.max(8, 14 / z);

  const strokesToErase = [];

  for (const s of state.strokes) {
    if (s.deleted) continue;
    const pl = viewport.getPageLayout(s.sheet || 0);

    // Fast AABB bounding box rejection
    if (s.bbox) {
      const sWorldMinX = pl.x + s.bbox[0];
      const sWorldMinY = pl.y + s.bbox[1];
      const sWorldMaxX = pl.x + s.bbox[2];
      const sWorldMaxY = pl.y + s.bbox[3];
      if (sWorldMaxX < wx - radius || sWorldMinX > wx + radius ||
          sWorldMaxY < wy - radius || sWorldMinY > wy + radius) {
        continue;
      }
    }

    // Precise segment proximity test
    const pts = s.points || [];
    let hit = false;
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const sx = pl.x + (pt.x !== undefined ? pt.x : pt[0]);
      const sy = pl.y + (pt.y !== undefined ? pt.y : pt[1]);
      const effectiveR = radius + ((pt.w !== undefined ? pt.w : s.base_width || 1.6) / 2);

      if (Math.hypot(wx - sx, wy - sy) <= effectiveR) {
        hit = true;
        break;
      }

      if (i > 0) {
        const prev = pts[i - 1];
        const px = pl.x + (prev.x !== undefined ? prev.x : prev[0]);
        const py = pl.y + (prev.y !== undefined ? prev.y : prev[1]);
        if (distToSegment(wx, wy, px, py, sx, sy) <= effectiveR) {
          hit = true;
          break;
        }
      }
    }

    if (hit) {
      strokesToErase.push(s.id);
    }
  }

  if (strokesToErase.length > 0) {
    const deleted = documentOps.deleteStrokes(strokesToErase, { recordHistory: true });
    for (const d of deleted) {
      ipc.deleteStroke(d.id).catch(() => {});
    }
    compositor.redrawAll();
  }
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}
