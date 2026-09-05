/* ============================================================================
 * core/document.js — Authoritative Document Domain Operations for Inkwell
 * Owns document mutations (strokes, images, text, pages) and transaction records.
 * Does not own Tauri IPC transport or rendering logic directly.
 * ========================================================================== */

import { state, emit } from './state.js';
import * as history from './history.js';

let _mutationListener = null;

/**
 * Register a listener for persistence (WAL journaling, dirty flags) and compositor invalidation.
 * @param {Function} listener (type, payload) => void
 */
export function setMutationListener(listener) {
  _mutationListener = listener;
}

function notifyMutation(type, payload) {
  state.isDirty = true;
  if (typeof _mutationListener === 'function') {
    try {
      _mutationListener(type, payload);
    } catch (e) {
      console.warn('[inkwell/document] Mutation listener error:', e);
    }
  }
  emit('documentChanged', { type, payload });
}

// ---- Strokes Operations ----

export function rebuildStrokesBySheet() {
  const map = new Map();
  for (const s of state.strokes || []) {
    if (!s.deleted) {
      const sheet = s.sheet || 0;
      if (!map.has(sheet)) map.set(sheet, []);
      map.get(sheet).push(s);
    }
  }
  state._strokesBySheet = map;
}

export function getStrokesForSheet(sheetIndex) {
  if (!state._strokesBySheet) {
    rebuildStrokesBySheet();
  }
  return state._strokesBySheet.get(sheetIndex) || [];
}

export function addStroke(stroke, { recordHistory = true } = {}) {
  if (!stroke) return;
  if (!state.strokes) state.strokes = [];
  
  stroke.deleted = false;
  state.strokes.push(stroke);

  if (!state._strokesBySheet) state._strokesBySheet = new Map();
  const sheet = stroke.sheet || 0;
  if (!state._strokesBySheet.has(sheet)) state._strokesBySheet.set(sheet, []);
  state._strokesBySheet.get(sheet).push(stroke);

  if (recordHistory) {
    history.pushTransaction({
      type: 'add_stroke',
      stroke,
    });
  }

  notifyMutation('add_stroke', { stroke });
  return stroke;
}

export function deleteStrokes(strokeIds, { recordHistory = true } = {}) {
  if (!strokeIds || !strokeIds.length) return [];
  const idSet = new Set(strokeIds.map(String));
  const deletedStrokes = [];

  for (const s of state.strokes) {
    if (!s.deleted && idSet.has(String(s.id))) {
      s.deleted = true;
      deletedStrokes.push(s);
    }
  }

  if (deletedStrokes.length > 0) {
    rebuildStrokesBySheet();
    if (recordHistory) {
      history.pushTransaction({
        type: 'erase_strokes',
        strokes: deletedStrokes,
      });
    }
    notifyMutation('erase_strokes', { strokes: deletedStrokes });
  }

  return deletedStrokes;
}

export function clearPageInk(sheetIndex, { recordHistory = true } = {}) {
  const strokesOnSheet = (state.strokes || []).filter(s => !s.deleted && (s.sheet || 0) === sheetIndex);
  if (!strokesOnSheet.length) return [];

  for (const s of strokesOnSheet) {
    s.deleted = true;
  }

  rebuildStrokesBySheet();

  if (recordHistory) {
    history.pushTransaction({
      type: 'erase_strokes',
      strokes: strokesOnSheet,
    });
  }

  notifyMutation('erase_strokes', { strokes: strokesOnSheet });
  return strokesOnSheet;
}

// ---- Image Operations ----

export function upsertImage(imageObj, { recordHistory = true, isNew = false } = {}) {
  if (!imageObj || !imageObj.id) return;
  if (!state.images) state.images = [];

  imageObj.deleted = false;
  const existingIdx = state.images.findIndex(img => String(img.id) === String(imageObj.id));
  if (existingIdx >= 0) {
    state.images[existingIdx] = imageObj;
  } else {
    state.images.push(imageObj);
  }

  if (recordHistory && isNew) {
    history.pushTransaction({
      type: 'add_image',
      image: imageObj,
    });
  }

  notifyMutation('upsert_image', { image: imageObj, isNew });
  return imageObj;
}

export function deleteImage(imageId, { recordHistory = true } = {}) {
  if (!imageId || !state.images) return null;
  const img = state.images.find(im => String(im.id) === String(imageId));
  if (!img || img.deleted) return null;

  img.deleted = true;

  if (recordHistory) {
    history.pushTransaction({
      type: 'delete_image',
      image: img,
    });
  }

  notifyMutation('delete_image', { image: img });
  return img;
}

// ---- Text Note Operations ----

export function upsertTextObject(textObj, { recordHistory = true, isNew = false } = {}) {
  if (!textObj || !textObj.id) return;
  if (!state.textObjects) state.textObjects = [];

  textObj.deleted = false;
  if (!textObj.width || !textObj.height) {
    const fontSize = textObj.fontSize || 16;
    const lines = (textObj.text || '').split('\n');
    let maxLineW = 100;
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.font = `${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
        for (const line of lines) {
          const w = ctx.measureText(line).width;
          if (w > maxLineW) maxLineW = w;
        }
      }
    }
    textObj.width = Math.max(10, maxLineW + 16);
    textObj.height = Math.max(20, lines.length * fontSize * 1.35 + 8);
  }

  const existingIdx = state.textObjects.findIndex(t => String(t.id) === String(textObj.id));
  if (existingIdx >= 0) {
    state.textObjects[existingIdx] = textObj;
  } else {
    state.textObjects.push(textObj);
  }

  if (recordHistory && isNew) {
    history.pushTransaction({
      type: 'add_text_object',
      textObj,
    });
  }

  notifyMutation('upsert_text', { textObj, isNew });
  return textObj;
}

export function deleteTextObject(textId, { recordHistory = true } = {}) {
  if (!textId || !state.textObjects) return null;
  const t = state.textObjects.find(txt => String(txt.id) === String(textId));
  if (!t || t.deleted) return null;

  t.deleted = true;

  if (recordHistory) {
    history.pushTransaction({
      type: 'delete_text_object',
      textObj: t,
    });
  }

  notifyMutation('delete_text', { textObj: t });
  return t;
}

// ---- Multi-Object Batch Deletion & Transformations ----

export function deleteObjectsBatch({ strokes = [], images = [], textObjects = [] }, { recordHistory = true } = {}) {
  const deletedStrokes = [];
  const deletedImages = [];
  const deletedTexts = [];

  for (const s of strokes) {
    if (!s.deleted) {
      s.deleted = true;
      deletedStrokes.push(s);
    }
  }
  for (const img of images) {
    if (!img.deleted) {
      img.deleted = true;
      deletedImages.push(img);
    }
  }
  for (const t of textObjects) {
    if (!t.deleted) {
      t.deleted = true;
      deletedTexts.push(t);
    }
  }

  if (deletedStrokes.length || deletedImages.length || deletedTexts.length) {
    if (deletedStrokes.length) rebuildStrokesBySheet();
    if (recordHistory) {
      history.pushTransaction({
        type: 'delete_objects',
        strokes: deletedStrokes,
        images: deletedImages,
        textObjects: deletedTexts,
      });
    }
    notifyMutation('delete_objects', {
      strokes: deletedStrokes,
      images: deletedImages,
      textObjects: deletedTexts,
    });
  }
}

export function commitTransform({ initialStrokes = [], initialImages = [], initialTextObjects = [], finalStrokes = [], finalImages = [], finalTextObjects = [] }, { recordHistory = true } = {}) {
  if (recordHistory) {
    history.pushTransaction({
      type: 'transform_objects',
      initialStrokes: initialStrokes.map(s => ({ id: s.id, points: s.points.map(p => ({ ...p })) })),
      initialImages: initialImages.map(img => ({ id: img.id, x: img.x, y: img.y, width: img.width, height: img.height })),
      initialTextObjects: initialTextObjects.map(t => ({ id: t.id, x: t.x, y: t.y, fontSize: t.fontSize })),
      finalStrokes: finalStrokes.map(s => ({ id: s.id, points: s.points.map(p => ({ ...p })) })),
      finalImages: finalImages.map(img => ({ id: img.id, x: img.x, y: img.y, width: img.width, height: img.height })),
      finalTextObjects: finalTextObjects.map(t => ({ id: t.id, x: t.x, y: t.y, fontSize: t.fontSize })),
    });
  }

  notifyMutation('transform_objects', {
    strokes: state.selectedStrokes,
    images: state.selectedImages,
    textObjects: state.selectedTextObjects,
  });
}

// ---- Document Setup & Page Management ----

export function setDocument({ pageInfos = [], strokes = [], images = [], textObjects = [], outline = [], bookmarks = [] } = {}) {
  state.pageInfos = pageInfos;
  state.strokes = strokes;
  state.images = images;
  state.textObjects = textObjects;
  state.outline = outline;
  state.bookmarks = bookmarks;
  state.selectedStrokes = [];
  state.selectedImages = [];
  state.selectedTextObjects = [];
  state.isDirty = false;

  // Clear PDF text layer caches, selection, and search state
  state.pageTextData = {};
  state.pageTextSpans = {};
  state.pageTextLoading = {};
  state.selectedTextSpans = [];
  state.selectedTextString = '';
  state.textSelection = null;
  state.textSelectAnchor = null;
  state.textSelectPending = null;
  state.isSelectingText = false;
  state.searchQuery = '';
  state.searchResults = [];
  state.activeSearchMatch = 0;
  state.isSearching = false;

  rebuildStrokesBySheet();
  history.clearHistory();
  emit('documentLoaded', { pageInfos, strokesCount: strokes.length });
}

export function insertPageAtIndex(targetIndex, pageInfo) {
  if (!state.pageInfos) state.pageInfos = [];
  const insertIdx = Math.max(0, Math.min(state.pageInfos.length, targetIndex));
  state.pageInfos.splice(insertIdx, 0, pageInfo);

  // Shift sheet index of any existing strokes, images, text on or after insertIdx
  for (const s of state.strokes || []) {
    if (s.sheet >= insertIdx) s.sheet += 1;
  }
  for (const img of state.images || []) {
    if (img.sheet >= insertIdx) img.sheet += 1;
  }
  for (const t of state.textObjects || []) {
    if (t.sheet >= insertIdx) t.sheet += 1;
  }

  // Shift cached page text data for indices >= insertIdx
  if (state.pageTextData && Object.keys(state.pageTextData).length > 0) {
    const newPageTextData = {};
    const newPageTextSpans = {};
    for (const key of Object.keys(state.pageTextData).map(Number).sort((a, b) => b - a)) {
      if (key >= insertIdx) {
        newPageTextData[key + 1] = state.pageTextData[key];
        if (state.pageTextSpans && state.pageTextSpans[key]) {
          newPageTextSpans[key + 1] = state.pageTextSpans[key];
        }
      } else {
        newPageTextData[key] = state.pageTextData[key];
        if (state.pageTextSpans && state.pageTextSpans[key]) {
          newPageTextSpans[key] = state.pageTextSpans[key];
        }
      }
    }
    state.pageTextData = newPageTextData;
    state.pageTextSpans = newPageTextSpans;
  }

  rebuildStrokesBySheet();
  notifyMutation('insert_page', { pageIndex: insertIdx, pageInfo });
  return insertIdx;
}

export function insertPage(afterIndex, pageInfo) {
  return insertPageAtIndex(afterIndex + 1, pageInfo);
}

// ---- Undo / Redo Domain Dispatches ----

export function performUndo() {
  const tx = history.popUndo();
  if (!tx) return false;

  if (tx.type === 'add_stroke' && tx.stroke) {
    tx.stroke.deleted = true;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_add_stroke', { stroke: tx.stroke });
  } else if (tx.type === 'erase_strokes' && tx.strokes) {
    for (const s of tx.strokes) s.deleted = false;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_erase_strokes', { strokes: tx.strokes });
  } else if (tx.type === 'delete_objects') {
    for (const s of (tx.strokes || [])) s.deleted = false;
    for (const img of (tx.images || [])) img.deleted = false;
    for (const t of (tx.textObjects || [])) t.deleted = false;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_delete_objects', tx);
  } else if (tx.type === 'add_objects') {
    for (const s of (tx.strokes || [])) s.deleted = true;
    for (const img of (tx.images || [])) img.deleted = true;
    for (const t of (tx.textObjects || [])) t.deleted = true;
    rebuildStrokesBySheet();
    history.pushRedo(tx);
    notifyMutation('undo_add_objects', tx);
  } else if (tx.type === 'add_image' && tx.image) {
    tx.image.deleted = true;
    history.pushRedo(tx);
    notifyMutation('undo_add_image', { image: tx.image });
  } else if (tx.type === 'delete_image' && tx.image) {
    tx.image.deleted = false;
    history.pushRedo(tx);
    notifyMutation('undo_delete_image', { image: tx.image });
  } else if (tx.type === 'add_text_object' && tx.textObj) {
    tx.textObj.deleted = true;
    history.pushRedo(tx);
    notifyMutation('undo_add_text_object', { textObj: tx.textObj });
  } else if (tx.type === 'delete_text_object' && tx.textObj) {
    tx.textObj.deleted = false;
    history.pushRedo(tx);
    notifyMutation('undo_delete_text_object', { textObj: tx.textObj });
  } else if (tx.type === 'transform_objects') {
    for (const init of (tx.initialStrokes || [])) {
      const s = state.strokes.find(st => st.id === init.id);
      if (s) {
        s.points = init.points.map(p => ({ ...p }));
        s._cachedPath2D = null;
        if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
          s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
        }
      }
    }
    rebuildStrokesBySheet();
    for (const init of (tx.initialImages || [])) {
      const img = (state.images || []).find(im => im.id === init.id);
      if (img) {
        img.x = init.x; img.y = init.y;
        img.width = init.width; img.height = init.height;
      }
    }
    for (const init of (tx.initialTextObjects || [])) {
      const t = (state.textObjects || []).find(txt => txt.id === init.id);
      if (t) {
        t.x = init.x; t.y = init.y;
        if (init.fontSize) t.fontSize = init.fontSize;
      }
    }
    history.pushRedo(tx);
    notifyMutation('undo_transform_objects', tx);
  }

  return true;
}

export function performRedo() {
  const tx = history.popRedo();
  if (!tx) return false;

  if (tx.type === 'add_stroke' && tx.stroke) {
    tx.stroke.deleted = false;
    rebuildStrokesBySheet();
    history.pushUndoRaw(tx);
    notifyMutation('redo_add_stroke', { stroke: tx.stroke });
  } else if (tx.type === 'erase_strokes' && tx.strokes) {
    for (const s of tx.strokes) s.deleted = true;
    rebuildStrokesBySheet();
    history.pushUndoRaw(tx);
    notifyMutation('redo_erase_strokes', { strokes: tx.strokes });
  } else if (tx.type === 'delete_objects') {
    for (const s of (tx.strokes || [])) s.deleted = true;
    for (const img of (tx.images || [])) img.deleted = true;
    for (const t of (tx.textObjects || [])) t.deleted = true;
    rebuildStrokesBySheet();
    history.pushUndoRaw(tx);
    notifyMutation('redo_delete_objects', tx);
  } else if (tx.type === 'add_objects') {
    for (const s of (tx.strokes || [])) s.deleted = false;
    for (const img of (tx.images || [])) img.deleted = false;
    for (const t of (tx.textObjects || [])) t.deleted = false;
    rebuildStrokesBySheet();
    history.pushUndoRaw(tx);
    notifyMutation('redo_add_objects', tx);
  } else if (tx.type === 'transform_objects') {
    for (const final of (tx.finalStrokes || [])) {
      const s = state.strokes.find(st => st.id === final.id);
      if (s) {
        s.points = final.points.map(p => ({ ...p }));
        s._cachedPath2D = null;
        if (window.Ink && typeof window.Ink.computeStrokeBbox === 'function') {
          s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
        }
      }
    }
    rebuildStrokesBySheet();
    for (const final of (tx.finalImages || [])) {
      const img = (state.images || []).find(im => im.id === final.id);
      if (img) {
        img.x = final.x; img.y = final.y;
        img.width = final.width; img.height = final.height;
      }
    }
    for (const final of (tx.finalTextObjects || [])) {
      const t = (state.textObjects || []).find(txt => txt.id === final.id);
      if (t) {
        t.x = final.x; t.y = final.y;
        if (final.fontSize) t.fontSize = final.fontSize;
      }
    }
    history.pushUndoRaw(tx);
    notifyMutation('redo_transform_objects', tx);
  } else if (tx.type === 'add_image' && tx.image) {
    tx.image.deleted = false;
    history.pushUndoRaw(tx);
    notifyMutation('redo_add_image', { image: tx.image });
  } else if (tx.type === 'delete_image' && tx.image) {
    tx.image.deleted = true;
    history.pushUndoRaw(tx);
    notifyMutation('redo_delete_image', { image: tx.image });
  } else if (tx.type === 'add_text_object' && tx.textObj) {
    tx.textObj.deleted = false;
    history.pushUndoRaw(tx);
    notifyMutation('redo_add_text_object', { textObj: tx.textObj });
  } else if (tx.type === 'delete_text_object' && tx.textObj) {
    tx.textObj.deleted = true;
    history.pushUndoRaw(tx);
    notifyMutation('redo_delete_text_object', { textObj: tx.textObj });
  }

  return true;
}
