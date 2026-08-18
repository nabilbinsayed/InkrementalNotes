/* ============================================================================
 * workspace/navigation.js — Document Page Navigation & History for Inkwell
 * Handles page jumps, fit-to-width/panes, and breadcrumb navigation history.
 * ========================================================================== */

import { state, emit } from '../core/state.js';
import * as compositor from '../render/compositor.js';

const _navHistory = [];
let _navIndex = -1;

export function pushNav(sheet) {
  if (_navIndex >= 0 && _navHistory[_navIndex] === sheet) return;
  if (_navIndex < _navHistory.length - 1) {
    _navHistory.splice(_navIndex + 1);
  }
  _navHistory.push(sheet);
  _navIndex = _navHistory.length - 1;
}

export function navBack(viewport) {
  if (_navIndex > 0 && viewport) {
    _navIndex--;
    goToPage(_navHistory[_navIndex], 'left', viewport, false);
  }
}

export function navForward(viewport) {
  if (_navIndex < _navHistory.length - 1 && viewport) {
    _navIndex++;
    goToPage(_navHistory[_navIndex], 'left', viewport, false);
  }
}

export function goToPage(pageIdx, pane = 'left', viewport = null, recordNav = true) {
  if (!state.pageInfos || pageIdx < 0 || pageIdx >= state.pageInfos.length) return;
  if (recordNav && (pane !== 'right' || !viewport || !viewport.splitMode)) {
    pushNav(pageIdx);
  }

  if (pane === 'right' && viewport && viewport.splitMode) {
    state.rightSheet = pageIdx;
  } else {
    state.leftSheet = pageIdx;
  }

  if (viewport) {
    viewport.scrollToPage(pageIdx, pane);
  }

  emit('pageChanged', { pageIndex: pageIdx, pane, totalPages: state.pageInfos.length });
  compositor.scheduleRedrawTiles();
  compositor.redrawAll();
}

export function fitPageInPanes(viewport, stageRect, piLeft = state.pageInfos[state.leftSheet], piRight = state.pageInfos[state.rightSheet]) {
  if (!piLeft || !viewport) return;
  if (!stageRect) compositor.updateStageRect();
  const r = stageRect || compositor.getStageRect() || { width: 800, height: 600 };
  const stageW = r.width;
  const stageH = r.height;
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

  compositor.scheduleRedrawTiles();
  compositor.redrawAll();
}

export function syncActivePagesFromViewport(viewport) {
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
    emit('activePagesChanged', { left: state.leftSheet, right: state.rightSheet });
  }
}
