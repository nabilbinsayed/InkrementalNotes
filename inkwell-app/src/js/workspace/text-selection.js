/* ============================================================================
 * workspace/text-selection.js — PDF Text Selection & Search Highlights
 * Manages PDF text layer selection, search matches, and text copy operations.
 * ========================================================================== */

import { state, emit } from '../core/state.js';
import * as compositor from '../render/compositor.js';

export function copySelectedPdfText() {
  if (!state.selectedTextString) return false;
  navigator.clipboard.writeText(state.selectedTextString)
    .then(() => {
      emit('toast', { message: 'Copied PDF text to clipboard', type: 'info' });
    })
    .catch(err => console.warn('[inkwell/text-selection] Failed to copy text:', err));
  return true;
}

export function clearTextSelection() {
  state.selectedTextSpans = [];
  state.selectedTextString = '';
  state.isSelectingText = false;
  compositor.redrawAll();
}

export function drawSearchHighlights(ctx, viewport, dpr, pane = 'left') {
  if (!ctx || !state.searchQuery || !state.searchResults || !state.searchResults.length || !viewport) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  const activeMatch = state.searchResults[state.activeSearchMatch];

  for (let i = 0; i < state.searchResults.length; i++) {
    const res = state.searchResults[i];
    const pl = viewport.getPageLayout(res.pageIndex || 0);
    const [sx0, sy0] = viewport.worldToScreen(pl.x + res.rect[0], pl.y + res.rect[1], pane);
    const [sx1, sy1] = viewport.worldToScreen(pl.x + res.rect[2], pl.y + res.rect[3], pane);

    const isCurrent = (res === activeMatch);
    ctx.fillStyle = isCurrent ? 'rgba(234, 179, 8, 0.65)' : 'rgba(250, 204, 21, 0.35)';
    ctx.strokeStyle = isCurrent ? '#ca8a04' : 'rgba(202, 138, 4, 0.5)';
    ctx.lineWidth = 1;

    ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
    ctx.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  }

  ctx.restore();
}
