/* ============================================================================
 * workspace/text-selection.js — PDF Text Selection & Search Highlights
 * Manages PDF text layer selection, search matches, and text copy operations.
 * ========================================================================== */

import { state, emit } from '../core/state.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';

export async function ensurePageTextData(sheet) {
  if (sheet == null || sheet < 0) return null;
  if (state.pageTextData && state.pageTextData[sheet]) return state.pageTextData[sheet];
  if (state.pageTextLoading && state.pageTextLoading[sheet]) {
    return state.pageTextLoading[sheet];
  }

  if (!state.pageTextLoading) state.pageTextLoading = {};

  const loadPromise = (async () => {
    try {
      const data = await ipc.invokeTauri('get_page_text_data', { pageIndex: sheet });
      if (data) {
        if (!state.pageTextData) state.pageTextData = {};
        if (!state.pageTextSpans) state.pageTextSpans = {};
        state.pageTextData[sheet] = data;
        state.pageTextSpans[sheet] = data.spans || [];
        return data;
      }
    } catch (err) {
      console.warn('[inkwell/text-selection] get_page_text_data failed for page', sheet, err);
    } finally {
      if (state.pageTextLoading) {
        delete state.pageTextLoading[sheet];
      }
    }
    return null;
  })();

  state.pageTextLoading[sheet] = loadPromise;
  return loadPromise;
}

export async function loadPageTextData(sheet) {
  return ensurePageTextData(sheet);
}

export function preloadNearbyPageText(centerSheet, viewport = null) {
  if (centerSheet == null || centerSheet < 0) centerSheet = state.leftSheet || 0;
  const numPages = state.pageInfos ? state.pageInfos.length : 1;
  const sheetsToLoad = new Set();

  if (centerSheet >= 0 && centerSheet < numPages) {
    sheetsToLoad.add(centerSheet);
  }

  if (viewport && typeof viewport.getVisiblePages === 'function') {
    const visibleLeft = viewport.getVisiblePages('left', 200) || [];
    for (const pl of visibleLeft) {
      if (pl.sheet >= 0 && pl.sheet < numPages) sheetsToLoad.add(pl.sheet);
    }
    if (viewport.splitMode) {
      const visibleRight = viewport.getVisiblePages('right', 200) || [];
      for (const pl of visibleRight) {
        if (pl.sheet >= 0 && pl.sheet < numPages) sheetsToLoad.add(pl.sheet);
      }
    }
  }

  if (centerSheet > 0) sheetsToLoad.add(centerSheet - 1);
  if (centerSheet + 1 < numPages) sheetsToLoad.add(centerSheet + 1);

  for (const s of sheetsToLoad) {
    if (!state.pageTextData[s] && (!state.pageTextLoading || !state.pageTextLoading[s])) {
      ensurePageTextData(s);
    }
  }
}

export function sortTextSpans(spans) {
  if (!spans || !spans.length) return [];
  return spans.slice().sort((a, b) => {
    const sheetA = a.page_index !== undefined ? a.page_index : (a.sheet || 0);
    const sheetB = b.page_index !== undefined ? b.page_index : (b.sheet || 0);
    if (sheetA !== sheetB) return sheetA - sheetB;

    const midYa = (a.rect[1] + a.rect[3]) / 2;
    const midYb = (b.rect[1] + b.rect[3]) / 2;
    const heightAvg = Math.max(8, ((a.rect[3] - a.rect[1]) + (b.rect[3] - b.rect[1])) / 2);
    if (Math.abs(midYa - midYb) > heightAvg * 0.5) {
      return a.rect[1] - b.rect[1];
    }
    return a.rect[0] - b.rect[0];
  });
}

export function mergeTextSpansIntoLines(spans) {
  if (!spans || !spans.length) return [];
  const sorted = sortTextSpans(spans);
  const lines = [];
  let currentLine = null;

  for (const span of sorted) {
    const sheet = span.page_index !== undefined ? span.page_index : (span.sheet || 0);
    const [x0, y0, x1, y1] = span.rect;
    const midY = (y0 + y1) / 2;
    const h = Math.max(8, y1 - y0);

    if (!currentLine) {
      currentLine = {
        sheet,
        rect: [x0, y0, x1, y1],
        midY,
        h,
        text: span.text || '',
        spans: [span]
      };
      lines.push(currentLine);
    } else {
      const isSameSheet = currentLine.sheet === sheet;
      const isSameLine = Math.abs(currentLine.midY - midY) < Math.max(currentLine.h, h) * 0.6;
      const isAdjacentX = x0 >= currentLine.rect[0] - 5 && x0 <= currentLine.rect[2] + 35;

      if (isSameSheet && isSameLine && isAdjacentX) {
        currentLine.rect[0] = Math.min(currentLine.rect[0], x0);
        currentLine.rect[1] = Math.min(currentLine.rect[1], y0);
        currentLine.rect[2] = Math.max(currentLine.rect[2], x1);
        currentLine.rect[3] = Math.max(currentLine.rect[3], y1);
        currentLine.midY = (currentLine.rect[1] + currentLine.rect[3]) / 2;
        currentLine.h = currentLine.rect[3] - currentLine.rect[1];
        currentLine.text += (currentLine.text.endsWith(' ') || span.text.startsWith(' ') ? '' : ' ') + (span.text || '');
        currentLine.spans.push(span);
      } else {
        currentLine = {
          sheet,
          rect: [x0, y0, x1, y1],
          midY,
          h,
          text: span.text || '',
          spans: [span]
        };
        lines.push(currentLine);
      }
    }
  }

  return lines;
}

export function findCharAndOffsetAtPageCoord(sheet, px, py) {
  const pageData = state.pageTextData ? state.pageTextData[sheet] : null;
  if (!pageData || !pageData.lines || !pageData.lines.length || !pageData.chars || !pageData.chars.length) {
    return null;
  }

  let bestLine = null;
  let bestLineDist = Infinity;

  for (const line of pageData.lines) {
    if (!line.chars || !line.chars.length) continue;
    const [lx0, ly0, lx1, ly1] = line.rect;

    let distY = 0;
    if (py < ly0) distY = ly0 - py;
    else if (py > ly1) distY = py - ly1;

    let distX = 0;
    if (px < lx0) distX = lx0 - px;
    else if (px > lx1) distX = px - lx1;

    const totalDist = distY * 8.0 + distX;
    if (totalDist < bestLineDist) {
      bestLineDist = totalDist;
      bestLine = line;
    }
  }

  if (!bestLine) {
    return { charIndex: 0, lineIndex: 0, char: pageData.chars[0] };
  }

  const chars = bestLine.chars;
  const firstChar = chars[0];
  const lastChar = chars[chars.length - 1];

  if (px <= firstChar.rect[0]) {
    return {
      charIndex: firstChar.char_index,
      lineIndex: bestLine.line_index,
      char: firstChar,
      isBefore: true,
      line: bestLine
    };
  }

  if (px >= lastChar.rect[2]) {
    return {
      charIndex: lastChar.char_index,
      lineIndex: bestLine.line_index,
      char: lastChar,
      isAfter: true,
      line: bestLine
    };
  }

  let closestChar = firstChar;
  let closestDist = Infinity;

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const cx0 = c.rect[0];
    const cx1 = c.rect[2];
    const midX = (cx0 + cx1) / 2;

    if (px >= cx0 && px <= cx1) {
      return {
        charIndex: c.char_index,
        lineIndex: bestLine.line_index,
        char: c,
        isBefore: px < midX,
        line: bestLine
      };
    }

    const d = Math.abs(px - midX);
    if (d < closestDist) {
      closestDist = d;
      closestChar = c;
    }
  }

  return {
    charIndex: closestChar.char_index,
    lineIndex: bestLine.line_index,
    char: closestChar,
    isBefore: px < (closestChar.rect[0] + closestChar.rect[2]) / 2,
    line: bestLine
  };
}

export function computeTextSelectionRanges(sheet, startCharIdx, endCharIdx) {
  const pageData = state.pageTextData ? state.pageTextData[sheet] : null;
  if (!pageData || !pageData.chars || !pageData.chars.length) return null;

  const minIdx = Math.min(startCharIdx, endCharIdx);
  const maxIdx = Math.max(startCharIdx, endCharIdx);

  const selectedChars = pageData.chars.filter(c => c.char_index >= minIdx && c.char_index <= maxIdx);
  if (!selectedChars.length) return null;

  const selectedString = selectedChars.map(c => c.c).join('');

  const lineMap = new Map();
  for (const c of selectedChars) {
    if (!lineMap.has(c.line_index)) {
      lineMap.set(c.line_index, []);
    }
    lineMap.get(c.line_index).push(c);
  }

  const rects = [];
  for (const [lineIdx, rawCharsOnLine] of lineMap.entries()) {
    const charsOnLine = rawCharsOnLine.filter(c => c.c !== '\n' && c.c !== '\r');
    if (!charsOnLine.length) continue;
    const parentLine = (pageData.lines || []).find(l => l.line_index === lineIdx);

    charsOnLine.sort((a, b) => a.rect[0] - b.rect[0]);
    const firstC = charsOnLine[0];
    const lastC = charsOnLine[charsOnLine.length - 1];

    const x0 = firstC.rect[0];
    const x1 = lastC.rect[2];
    const y0 = parentLine ? parentLine.rect[1] : charsOnLine[0].rect[1];
    const y1 = parentLine ? parentLine.rect[3] : charsOnLine[0].rect[3];

    rects.push({
      sheet,
      lineIndex: lineIdx,
      rect: [x0, y0, x1, y1],
      text: charsOnLine.map(c => c.c).join(''),
      startCharIdx: firstC.char_index,
      endCharIdx: lastC.char_index,
      chars: charsOnLine
    });
  }

  rects.sort((a, b) => a.rect[1] - b.rect[1]);

  return {
    sheet,
    startCharIdx: minIdx,
    endCharIdx: maxIdx,
    text: selectedString,
    rects,
    chars: selectedChars
  };
}

export function expandSelectionToWord(sheet, charIndex) {
  const pageData = state.pageTextData ? state.pageTextData[sheet] : null;
  if (!pageData || !pageData.chars || !pageData.chars.length) return null;

  let idx = pageData.chars.findIndex(c => c.char_index === charIndex);
  if (idx < 0) idx = Math.max(0, Math.min(pageData.chars.length - 1, charIndex));

  const initialLine = pageData.chars[idx].line_index;
  let start = idx;
  let end = idx;

  const isWordChar = c => !/[\s\r\n\t.,!?;:()\[\]{}"'—–/\\]/.test(c);

  while (start > 0 && pageData.chars[start - 1].line_index === initialLine && isWordChar(pageData.chars[start - 1].c)) {
    start--;
  }
  while (end < pageData.chars.length - 1 && pageData.chars[end + 1].line_index === initialLine && isWordChar(pageData.chars[end + 1].c)) {
    end++;
  }

  return computeTextSelectionRanges(sheet, pageData.chars[start].char_index, pageData.chars[end].char_index);
}

export function expandSelectionToLine(sheet, charIndex) {
  const pageData = state.pageTextData ? state.pageTextData[sheet] : null;
  if (!pageData || !pageData.chars || !pageData.chars.length) return null;

  let c = pageData.chars.find(ch => ch.char_index === charIndex);
  if (!c) {
    c = pageData.chars[Math.max(0, Math.min(pageData.chars.length - 1, charIndex))];
  }
  if (!c) return null;

  const line = (pageData.lines || []).find(l => l.line_index === c.line_index);
  if (!line || !line.chars || !line.chars.length) return null;

  const start = line.chars[0].char_index;
  const end = line.chars[line.chars.length - 1].char_index;
  return computeTextSelectionRanges(sheet, start, end);
}

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
  state.textSelection = null;
  state.textSelectAnchor = null;
  state.textSelectPending = null;
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
