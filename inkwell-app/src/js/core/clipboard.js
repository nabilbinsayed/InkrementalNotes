/* ============================================================================
 * core/clipboard.js — Object and Image Clipboard Engine for Inkwell
 * Encapsulates copying, cutting, pasting, and duplicating of strokes/images/text.
 * ========================================================================== */

import { state, emit } from './state.js';
import * as documentOps from './document.js';
import * as ipc from './ipc.js';

let _clipboard = null;

export function hasClipboardContent() {
  return _clipboard !== null && _clipboard.type === 'inkwell_objects';
}

export function getClipboardData() {
  return _clipboard;
}

export function copySelection() {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);

  if (!strokes.length && !images.length && !texts.length) {
    return false;
  }

  _clipboard = {
    type: 'inkwell_objects',
    strokes: strokes.map(serializeStroke),
    images: images.map(serializeImage),
    texts: texts.map(serializeText),
  };

  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    if (texts.length && !strokes.length && !images.length) {
      navigator.clipboard.writeText(texts.map(t => t.text).join('\n')).catch(() => {});
    } else {
      try {
        navigator.clipboard.writeText(JSON.stringify(_clipboard)).catch(() => {});
      } catch (_) {}
    }
  }

  emit('clipboardChanged', { count: strokes.length + images.length + texts.length });
  return true;
}

function serializeStroke(s) {
  const pts = (s.points || s._pts || []).map(p => ({
    x: p.x,
    y: p.y,
    p: (p.p !== undefined) ? p.p : 0.8,
    w: (p.w !== undefined) ? p.w : (s.base_width || 1.6),
    t: p.t || 0,
  }));
  return {
    id: s.id,
    sheet: s.sheet || 0,
    kind: s.kind || 'pen',
    rgb: s.rgb ? [...s.rgb] : [0.08, 0.09, 0.14],
    base_width: s.base_width || s.baseWidth || 1.6,
    points: pts,
    _pts: pts,
    deleted: !!s.deleted,
  };
}

function serializeImage(img) {
  return {
    id: img.id,
    sheet: img.sheet || 0,
    x: img.x,
    y: img.y,
    width: img.width,
    height: img.height,
    dataUrl: img.dataUrl || '',
    deleted: !!img.deleted,
  };
}

function serializeText(t) {
  return {
    id: t.id,
    sheet: t.sheet || 0,
    x: t.x,
    y: t.y,
    text: t.text || '',
    fontSize: t.fontSize || 16,
    color: t.color || '#141724',
    bold: !!t.bold,
    italic: !!t.italic,
    width: t.width || 140,
    height: t.height || 32,
    deleted: !!t.deleted,
  };
}

export function cutSelection() {
  if (!copySelection()) return false;
  deleteSelection();
  return true;
}

export function deleteSelection() {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);

  if (!strokes.length && !images.length && !texts.length) {
    return false;
  }

  documentOps.deleteObjectsBatch({ strokes, images, textObjects: texts });

  state.selectedStrokes = [];
  state.selectedImages = [];
  state.selectedTextObjects = [];

  emit('selectionCleared', {});
  return true;
}

export function pasteClipboard(activeSheet = 0, offset = 16, targetPagePt = null) {
  if (!hasClipboardContent()) return false;

  const newStrokes = [];
  const newImages = [];
  const newTexts = [];

  let dx = offset;
  let dy = offset;

  if (targetPagePt && typeof targetPagePt.px === 'number' && typeof targetPagePt.py === 'number') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasBounds = false;
    for (const s of (_clipboard.strokes || [])) {
      const pts = s.points || s._pts || [];
      for (const p of pts) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        hasBounds = true;
      }
    }
    for (const img of (_clipboard.images || [])) {
      minX = Math.min(minX, img.x); minY = Math.min(minY, img.y);
      maxX = Math.max(maxX, img.x + img.width); maxY = Math.max(maxY, img.y + img.height);
      hasBounds = true;
    }
    for (const t of (_clipboard.texts || [])) {
      minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + (t.width || 120)); maxY = Math.max(maxY, t.y + (t.height || 32));
      hasBounds = true;
    }
    if (hasBounds) {
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      dx = targetPagePt.px - centerX;
      dy = targetPagePt.py - centerY;
    }
  }

  for (const s of (_clipboard.strokes || [])) {
    const pts = (s.points || s._pts || []).map(p => ({
      x: p.x + dx,
      y: p.y + dy,
      p: (p.p !== undefined) ? p.p : 0.8,
      w: (p.w !== undefined) ? p.w : (s.base_width || 1.6),
      t: p.t || 0,
    }));
    const baseW = s.base_width || s.baseWidth || 1.6;
    const clone = {
      id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      sheet: activeSheet,
      kind: s.kind || 'pen',
      rgb: s.rgb ? [...s.rgb] : [0.08, 0.09, 0.14],
      base_width: baseW,
      points: pts,
      _pts: pts,
      deleted: false,
    };

    if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
      clone.bbox = window.Ink.computeStrokeBbox(clone.points, clone.base_width);
    }
    if (window.Ink && typeof window.Ink.getPath2D === 'function') {
      clone._cachedPath2D = window.Ink.getPath2D(clone);
    }

    documentOps.addStroke(clone, { recordHistory: false });
    ipc.commitStroke(clone.sheet, clone.kind || 'pen', clone.rgb, clone.base_width, clone.points, clone.id).catch(err => {
      console.warn('[inkwell/clipboard] commitStroke error:', err);
    });
    newStrokes.push(clone);
  }

  for (const img of (_clipboard.images || [])) {
    const clone = {
      id: 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      sheet: activeSheet,
      x: img.x + dx,
      y: img.y + dy,
      width: img.width,
      height: img.height,
      dataUrl: img.dataUrl || '',
      deleted: false,
    };

    if (clone.dataUrl) {
      const imgEl = new Image();
      imgEl.src = clone.dataUrl;
      clone._el = imgEl;
    }

    documentOps.upsertImage(clone, { recordHistory: false, isNew: true });
    ipc.journalImageMutation('upsert', clone).catch(() => {});
    newImages.push(clone);
  }

  for (const t of (_clipboard.texts || [])) {
    const clone = {
      id: 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      sheet: activeSheet,
      x: t.x + dx,
      y: t.y + dy,
      text: t.text || '',
      fontSize: t.fontSize || 16,
      color: t.color || '#141724',
      bold: !!t.bold,
      italic: !!t.italic,
      width: t.width || 140,
      height: t.height || 32,
      deleted: false,
    };

    documentOps.upsertTextObject(clone, { recordHistory: false, isNew: true });
    ipc.journalTextMutation('upsert', clone);
    newTexts.push(clone);
  }

  // Record batch add in history
  if (newStrokes.length || newImages.length || newTexts.length) {
    import('./history.js').then(history => {
      history.pushTransaction({
        type: 'add_objects',
        strokes: newStrokes,
        images: newImages,
        textObjects: newTexts,
      });
    });
  }

  state.selectedStrokes = newStrokes;
  state.selectedImages = newImages;
  state.selectedTextObjects = newTexts;

  import('../tools/tool-manager.js').then(tm => {
    tm.setTool('lasso', { isUserSwitch: false });
    import('../ui/toolbar.js').then(tb => tb.updateToolbarUI()).catch(() => {});
  }).catch(() => {});

  emit('selectionChanged', { strokes: newStrokes, images: newImages, textObjects: newTexts });
  return true;
}

export async function pasteFromSystemClipboard(activeSheet = 0, targetPagePt = null) {
  if (hasClipboardContent()) {
    return pasteClipboard(activeSheet, 16, targetPagePt);
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) return false;

      try {
        const data = JSON.parse(text);
        if (data && data.type === 'inkwell_objects') {
          _clipboard = data;
          return pasteClipboard(activeSheet, 16, targetPagePt);
        }
      } catch (_) {}

      const px = (targetPagePt && typeof targetPagePt.px === 'number') ? targetPagePt.px : 80;
      const py = (targetPagePt && typeof targetPagePt.py === 'number') ? targetPagePt.py : 120;
      const newTextObj = {
        id: 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        sheet: activeSheet,
        x: px,
        y: py,
        text: text.trim(),
        fontSize: 16,
        color: state.textColor || '#141724',
        bold: false,
        italic: false,
        width: Math.max(140, Math.min(400, text.length * 8)),
        height: 36,
        deleted: false,
      };

      documentOps.upsertTextObject(newTextObj, { recordHistory: true, isNew: true });
      ipc.journalTextMutation('upsert', newTextObj);

      state.selectedStrokes = [];
      state.selectedImages = [];
      state.selectedTextObjects = [newTextObj];

      import('../tools/tool-manager.js').then(tm => {
        tm.setTool('lasso', { isUserSwitch: false });
        import('../ui/toolbar.js').then(tb => tb.updateToolbarUI()).catch(() => {});
      }).catch(() => {});

      emit('selectionChanged', { strokes: [], images: [], textObjects: [newTextObj] });
      return true;
    } catch (err) {
      console.warn('[inkwell/clipboard] pasteFromSystemClipboard error:', err);
    }
  }

  return false;
}

export function duplicateSelection(activeSheet = 0, offset = 18) {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);

  if (!strokes.length && !images.length && !texts.length) return false;

  const tempClipboard = _clipboard;
  _clipboard = {
    type: 'inkwell_objects',
    strokes: strokes.map(serializeStroke),
    images: images.map(serializeImage),
    texts: texts.map(serializeText),
  };

  const result = pasteClipboard(activeSheet, offset);
  _clipboard = tempClipboard;
  return result;
}
