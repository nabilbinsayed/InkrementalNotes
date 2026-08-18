/* ============================================================================
 * tools/laser.js — Ephemeral Laser Pointer Adapter for Inkwell
 * Renders glowing presentation laser trails with real-time decaying particle tails.
 * ========================================================================== */

import { state } from '../core/state.js';
import * as compositor from '../render/compositor.js';
import * as overlays from '../render/overlays.js';

let _animId = null;

export function onLaserDown(e, ptWorld, pane, viewport) {
  state.laserPoints = [];
  addLaserPoint(ptWorld[0], ptWorld[1]);
  startLaserLoop(pane, viewport);
}

export function onLaserMove(e, ptWorld, pane, viewport) {
  addLaserPoint(ptWorld[0], ptWorld[1]);
}

export function onLaserUp() {
  clearLaser();
}

export function clearLaser() {
  state.laserPoints = [];
  if (_animId) {
    cancelAnimationFrame(_animId);
    _animId = null;
  }
  compositor.clearWet();
}

function addLaserPoint(x, y) {
  if (!state.laserPoints) state.laserPoints = [];
  state.laserPoints.push({
    x,
    y,
    time: Date.now(),
    radius: 6,
  });

  // Limit trail length
  if (state.laserPoints.length > 50) {
    state.laserPoints.shift();
  }
}

function startLaserLoop(pane, viewport) {
  if (_animId) return;

  function loop() {
    const now = Date.now();
    state.laserPoints = (state.laserPoints || []).filter(pt => now - pt.time < 1000);

    compositor.clearWet();
    const { wctx } = compositor.getContexts();
    if (wctx && state.laserPoints.length > 0) {
      overlays.drawLaserPointer(wctx, state, viewport, state.dpr, pane);
      _animId = requestAnimationFrame(loop);
    } else {
      _animId = null;
    }
  }

  _animId = requestAnimationFrame(loop);
}
