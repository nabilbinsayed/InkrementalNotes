/* ============================================================================
 * tools/eraser.js — Precision Stroke Eraser Adapter for Inkwell
 * Performs proximity hit-testing across visible pages and deletes strokes.
 * ========================================================================== */

import { state, warnDurability } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';

let erasedInGesture = new Set();
let erasedStrokesInGesture = new Set();

export function onEraserDown(e, ptWorld, pane, viewport) {
  state.isErasing = true;
  erasedInGesture.clear();
  erasedStrokesInGesture.clear();
  eraseStrokesAt(ptWorld, pane, viewport);
}

export function onEraserMove(e, ptWorld, pane, viewport) {
  if (!state.isErasing) return;
  eraseStrokesAt(ptWorld, pane, viewport);
}

export function onEraserUp() {
  state.isErasing = false;
  commitErasedStrokes();
}

function commitErasedStrokes() {
  if (!erasedInGesture || erasedInGesture.size === 0) return;
  const idsToErase = Array.from(erasedInGesture);
  erasedInGesture.clear();

  for (const s of erasedStrokesInGesture) {
    s.deleted = false;
  }
  erasedStrokesInGesture.clear();

  const deleted = documentOps.deleteStrokes(idsToErase, { recordHistory: true });
  for (const d of deleted) {
    ipc.deleteStroke(d.id).catch(err => {
      console.warn('[inkwell/eraser] deleteStroke error:', err);
      warnDurability('Erase may not persist: ' + err);
    });
  }
  compositor.scheduleRedrawAll();
}

export function eraseStrokesAt(ptWorld, pane, viewport) {
  if (!viewport) return;
  const wx = ptWorld[0];
  const wy = ptWorld[1];

  const pageCoord = viewport.worldToPage(wx, wy);
  const activeSheet = pageCoord ? pageCoord.sheet : 0;
  const sheetStrokes = documentOps.getStrokesForSheet(activeSheet);
  if (!sheetStrokes || !sheetStrokes.length) return;

  const z = (pane === 'right' && viewport.splitMode) ? viewport.rightZoom : viewport.zoom;
  const radius = Math.max(8, 14 / z);
  let hitAny = false;

  for (const s of sheetStrokes) {
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
      s.deleted = true;
      erasedInGesture.add(s.id);
      erasedStrokesInGesture.add(s);
      hitAny = true;
    }
  }

  if (hitAny) {
    if (!state.isErasing) {
      commitErasedStrokes();
    } else {
      compositor.scheduleRedrawAll();
    }
  }
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}
