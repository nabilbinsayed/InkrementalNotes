/* ============================================================================
 * workspace/scrollbar.js — Draggable Document Scrollbar for Inkwell
 * Renders floating scroll track, dynamic thumb sizing, and page tooltip.
 * ========================================================================== */

import { state, $ } from '../core/state.js';
import * as compositor from '../render/compositor.js';

let _isDraggingThumb = false;
let _startDragY = 0;
let _startPanY = 0;

export function updateDocScrollbar(viewport) {
  const track = $('docScrollbarTrack');
  const thumb = $('docScrollbarThumb');
  if (!track || !thumb || !viewport || !state.pageInfos || !state.pageInfos.length) return;

  const trackH = track.clientHeight || 400;
  const stageRect = compositor.getStageRect() || { height: 600 };
  const stageH = stageRect.height;
  const docTotalH = (viewport.totalDocHeight || 800) * viewport.zoom;

  const thumbH = Math.max(28, Math.min(trackH, (stageH / Math.max(stageH, docTotalH)) * trackH));
  thumb.style.height = `${thumbH}px`;

  const maxPan = Math.max(1, docTotalH - stageH);
  const scrollPct = Math.max(0, Math.min(1, (-viewport.panY + 30) / maxPan));
  const thumbTop = scrollPct * (trackH - thumbH);
  thumb.style.top = `${thumbTop}px`;
}

export function initDocScrollbar(viewport) {
  const scrollbar = $('docScrollbar');
  const track = $('docScrollbarTrack');
  const thumb = $('docScrollbarThumb');
  const tooltip = $('docScrollbarTooltip');
  if (!scrollbar || !track || !thumb || !viewport) return;

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
    const trackH = track.clientHeight;
    const docTotalH = (viewport.totalDocHeight || 800) * viewport.zoom;
    const stageRect = compositor.getStageRect() || { height: 600 };
    const stageH = stageRect.height;
    const thumbH = thumb.clientHeight;
    const scrollableTrack = Math.max(1, trackH - thumbH);

    const panDelta = (dy / scrollableTrack) * (docTotalH - stageH);
    viewport.setPan(viewport.panX, _startPanY - panDelta, 'left');
    compositor.scheduleRedrawTiles();
    compositor.redrawAll();
    updateDocScrollbar(viewport);

    const curPage = viewport.getActivePageInView('left');
    if (tooltip) {
      tooltip.textContent = `Page ${curPage + 1} / ${state.pageInfos.length || 1}`;
      tooltip.style.top = `${thumb.offsetTop + thumbH / 2}px`;
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
