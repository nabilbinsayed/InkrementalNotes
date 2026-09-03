/* ============================================================================
 * workspace/scrollbar.js — Draggable Document Scrollbar for Inkwell
 * Renders floating scroll track, dynamic thumb sizing, and page tooltip.
 * ========================================================================== */

import { state, $ } from '../core/state.js';
import * as compositor from '../render/compositor.js';

let _isDraggingThumb = false;
let _startDragY = 0;
let _startPanY = 0;
let _cachedTrackH = 0;
let _cachedThumbH = 28;
let _cachedThumbTop = 0;
let _resizeObserver = null;
let _rafPending = false;
let _pendingThumbH = null;
let _pendingThumbTop = null;
let _thumbEl = null;

function getTrackHeight(track) {
  if (_cachedTrackH > 0) return _cachedTrackH;
  if (track) {
    _cachedTrackH = track.clientHeight || 400;
  } else {
    _cachedTrackH = 400;
  }
  return _cachedTrackH;
}

function applyPendingThumb() {
  _rafPending = false;
  if (!_thumbEl) return;
  if (_pendingThumbH !== null) {
    _thumbEl.style.height = `${_pendingThumbH}px`;
    _pendingThumbH = null;
  }
  if (_pendingThumbTop !== null) {
    _thumbEl.style.transform = `translateY(${_pendingThumbTop}px)`;
    _thumbEl.style.top = '0px';
    _pendingThumbTop = null;
  }
}

function scheduleApplyThumb(thumb, h, top) {
  _thumbEl = thumb;
  _pendingThumbH = h;
  _pendingThumbTop = top;
  if (!_rafPending) {
    _rafPending = true;
    requestAnimationFrame(applyPendingThumb);
  }
}

export function updateDocScrollbar(viewport) {
  const track = $('docScrollbarTrack');
  const thumb = $('docScrollbarThumb');
  if (!track || !thumb || !viewport || !state.pageInfos || !state.pageInfos.length) return;

  const trackH = getTrackHeight(track);
  const stageRect = compositor.getStageRect() || { height: 600 };
  const stageH = stageRect.height;
  const docTotalH = (viewport.totalDocHeight || 800) * viewport.zoom;

  const thumbH = Math.max(28, Math.min(trackH, (stageH / Math.max(stageH, docTotalH)) * trackH));
  _cachedThumbH = thumbH;

  const maxPan = Math.max(1, docTotalH - stageH);
  const scrollPct = Math.max(0, Math.min(1, (-viewport.panY + 30) / maxPan));
  const thumbTop = scrollPct * (trackH - thumbH);
  _cachedThumbTop = thumbTop;

  scheduleApplyThumb(thumb, thumbH, thumbTop);
}

export function initDocScrollbar(viewport) {
  const scrollbar = $('docScrollbar');
  const track = $('docScrollbarTrack');
  const thumb = $('docScrollbarThumb');
  const tooltip = $('docScrollbarTooltip');
  if (!scrollbar || !track || !thumb || !viewport) return;

  // Cache track height on window resize and observer callbacks
  if (typeof ResizeObserver !== 'undefined' && track) {
    if (_resizeObserver) _resizeObserver.disconnect();
    _resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.contentRect && entry.contentRect.height > 0) {
          _cachedTrackH = entry.contentRect.height;
        } else if (track) {
          _cachedTrackH = track.clientHeight || 400;
        }
      }
    });
    _resizeObserver.observe(track);
  }

  window.addEventListener('resize', () => {
    if (track) _cachedTrackH = track.clientHeight || 400;
  });

  const onThumbDown = e => {
    e.preventDefault();
    e.stopPropagation();
    _isDraggingThumb = true;
    _startDragY = e.clientY;
    _startPanY = viewport.panY;
    scrollbar.classList.add('dragging');
    if (tooltip) tooltip.classList.remove('hidden');
    window.addEventListener('pointermove', onThumbMove);
    window.addEventListener('pointerup', onThumbUp);
  };

  const onThumbMove = e => {
    if (!_isDraggingThumb) return;
    const dy = e.clientY - _startDragY;
    const trackH = getTrackHeight(track);
    const docTotalH = (viewport.totalDocHeight || 800) * viewport.zoom;
    const stageRect = compositor.getStageRect() || { height: 600 };
    const stageH = stageRect.height;
    const thumbH = _cachedThumbH || 28;
    const scrollableTrack = Math.max(1, trackH - thumbH);

    const panDelta = (dy / scrollableTrack) * (docTotalH - stageH);
    viewport.setPan(viewport.panX, _startPanY - panDelta, 'left');

    const curPage = viewport.getActivePageInView('left');
    if (tooltip) {
      tooltip.textContent = `Page ${curPage + 1} / ${state.pageInfos.length || 1}`;
      const topPos = (_cachedThumbTop || 0) + thumbH / 2;
      tooltip.style.transform = `translateY(${topPos}px)`;
      tooltip.style.top = '0px';
    }
  };

  const onThumbUp = () => {
    _isDraggingThumb = false;
    scrollbar.classList.remove('dragging');
    if (tooltip) tooltip.classList.add('hidden');
    window.removeEventListener('pointermove', onThumbMove);
    window.removeEventListener('pointerup', onThumbUp);
  };

  thumb.addEventListener('pointerdown', onThumbDown);
}
