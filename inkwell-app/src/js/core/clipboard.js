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
    strokes: strokes.map(s => JSON.parse(JSON.stringify(s))),
    images: images.map(img => JSON.parse(JSON.stringify(img))),
    texts: texts.map(t => JSON.parse(JSON.stringify(t))),
  };

  emit('clipboardChanged', { count: strokes.length + images.length + texts.length });
  return true;
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

export function pasteClipboard(activeSheet = 0, offset = 16) {
  if (!hasClipboardContent()) return false;

  const newStrokes = [];
  const newImages = [];
  const newTexts = [];

  for (const s of (_clipboard.strokes || [])) {
    const clone = JSON.parse(JSON.stringify(s));
    clone.id = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    clone.sheet = activeSheet;
    clone.points.forEach(p => { p.x += offset; p.y += offset; });
    
    documentOps.addStroke(clone, { recordHistory: false });
    ipc.commitStroke(clone.sheet, clone.kind || clone.tool || 'pen', clone.rgb, clone.base_width || clone.baseWidth || 1.6, clone.points, clone.id).catch(err => {
      console.warn('[inkwell/clipboard] commitStroke error:', err);
    });
    newStrokes.push(clone);
  }

  for (const img of (_clipboard.images || [])) {
    const clone = JSON.parse(JSON.stringify(img));
    clone.id = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    clone.sheet = activeSheet;
    clone.x += offset;
    clone.y += offset;

    const imgEl = new Image();
    imgEl.src = clone.dataUrl;
    clone._el = imgEl;

    documentOps.upsertImage(clone, { recordHistory: false, isNew: true });
    newImages.push(clone);
  }

  for (const t of (_clipboard.texts || [])) {
    const clone = JSON.parse(JSON.stringify(t));
    clone.id = 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    clone.sheet = activeSheet;
    clone.x += offset;
    clone.y += offset;

    documentOps.upsertTextObject(clone, { recordHistory: false, isNew: true });
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

  emit('selectionChanged', { strokes: newStrokes, images: newImages, textObjects: newTexts });
  return true;
}

export function duplicateSelection(activeSheet = 0, offset = 18) {
  const strokes = (state.selectedStrokes || []).filter(s => !s.deleted);
  const images = (state.selectedImages || []).filter(img => !img.deleted);
  const texts = (state.selectedTextObjects || []).filter(t => !t.deleted);

  if (!strokes.length && !images.length && !texts.length) return false;

  const tempClipboard = _clipboard;
  _clipboard = {
    type: 'inkwell_objects',
    strokes: strokes.map(s => JSON.parse(JSON.stringify(s))),
    images: images.map(img => JSON.parse(JSON.stringify(img))),
    texts: texts.map(t => JSON.parse(JSON.stringify(t))),
  };

  const result = pasteClipboard(activeSheet, offset);
  _clipboard = tempClipboard;
  return result;
}
