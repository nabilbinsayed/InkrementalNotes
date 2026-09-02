/* ============================================================================
 * core/ipc.js — Tauri v2 Backend Transport & Bridge for Inkwell
 * Bridges JavaScript frontend to Rust backend commands and WAL journaler.
 * Keeps Tauri-specific invocation logic isolated from other domain modules.
 * ========================================================================== */

import { warnDurability } from './state.js';

export function getInvoke() {
  if (typeof window === 'undefined') return null;
  if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
    return window.__TAURI__.core.invoke;
  }
  if (window.__TAURI__ && window.__TAURI__.invoke) {
    return window.__TAURI__.invoke;
  }
  if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
    return window.__TAURI_INTERNALS__.invoke;
  }
  return null;
}

export async function invokeTauri(command, args = {}) {
  const invoke = getInvoke();
  if (!invoke) {
    // Graceful fallback for non-Tauri / test environments
    return null;
  }
  return await invoke(command, args);
}

// ---- Document File Operations ----

export async function openPdf(pathStr) {
  return await invokeTauri('open_pdf', { pathStr });
}

export async function openPdfDialog() {
  return await invokeTauri('open_pdf_dialog');
}

export async function openPdfBytes(name, bytes) {
  return await invokeTauri('open_pdf_bytes', { name, bytes });
}

export async function savePdf(pathStr, strokes, images, texts) {
  const payload = {
    strokes: (strokes || []).map(s => ({
      id: String(s.id),
      kind: s.kind || 'pen',
      rgb: s.rgb || [0.08, 0.09, 0.14],
      base_width: s.base_width || 1.6,
      sheet: s.sheet || 0,
      deleted: !!s.deleted,
      points: (s.points || []).map(p => ({
        x: p.x !== undefined ? p.x : (p[0] !== undefined ? p[0] : 0),
        y: p.y !== undefined ? p.y : (p[1] !== undefined ? p[1] : 0),
        w: p.w ?? (p.p !== undefined ? p.p : (p[2] !== undefined ? p[2] : 0.5)),
        p: p.p !== undefined ? p.p : (p[2] !== undefined ? p[2] : 0.5),
        t: p.t !== undefined ? p.t : (p[3] !== undefined ? p[3] : 0),
      })),
    })),
    images: (images || []).map(img => ({
      id: String(img.id),
      sheet: img.sheet || 0,
      x: img.x || 0,
      y: img.y || 0,
      width: img.width || 0,
      height: img.height || 0,
      data_url: img.dataUrl || img.data_url || '',
    })),
    texts: (texts || []).filter(t => !t.deleted).map(t => ({
      id: String(t.id),
      sheet: t.sheet || 0,
      x: t.x || 0,
      y: t.y || 0,
      text: t.text || '',
      font_size: t.fontSize || t.font_size || 16,
      color: t.color || '#141724',
      bold: !!t.bold,
      italic: !!t.italic,
      width: t.width || 120,
      height: t.height || 30,
    })),
  };
  if (!pathStr) {
    return await invokeTauri('save_pdf_dialog', payload);
  }
  return await invokeTauri('save_pdf', { outPathStr: pathStr, ...payload });
}

export async function newWhiteboard() {
  return await invokeTauri('create_blank_document');
}

export async function insertBlankPage(afterIndex = 0, widthPt = 595.0, heightPt = 842.0) {
  return await invokeTauri('insert_blank_page', { index: afterIndex, widthPt, heightPt });
}

export async function extractOutline() {
  return await invokeTauri('get_pdf_outline');
}

// ---- LOD Tile Rasterization ----

export async function fetchTile(pageIndex, rect, px) {
  return await invokeTauri('render_tile', { page: pageIndex, rect, px });
}

// ---- Vector Stroke Persistence ----

export async function commitStroke(sheet, tool, rgb, baseWidth, points, clientId = null) {
  const samplesPayload = (points || []).map(pt => ({
    x: pt.x !== undefined ? pt.x : pt[0],
    y: pt.y !== undefined ? pt.y : pt[1],
    pressure: pt.p !== undefined ? pt.p : (pt[2] !== undefined ? pt[2] : 0.5),
    t_ms: pt.t !== undefined ? pt.t : (pt[3] !== undefined ? pt[3] : 0),
  }));

  return await invokeTauri('commit_stroke', {
    sheet: sheet || 0,
    tool: tool || 'pen',
    rgb: rgb || [0.08, 0.09, 0.14],
    baseWidth: baseWidth || 1.6,
    samples: samplesPayload,
    clientId: clientId ? String(clientId) : null,
  });
}

export async function deleteStroke(strokeIdStr) {
  return await invokeTauri('delete_stroke', { strokeIdStr: String(strokeIdStr) });
}

// ---- WAL Mutation Journaling (Images & Text) ----

export function journalImageMutation(op, imgObj) {
  if (!imgObj) return;
  if (op === 'add' || op === 'upsert') {
    invokeTauri('journal_image_mutation', {
      op: 'upsert',
      image: {
        id: String(imgObj.id),
        sheet: imgObj.sheet || 0,
        x: imgObj.x,
        y: imgObj.y,
        width: imgObj.width,
        height: imgObj.height,
        data_url: imgObj.dataUrl || '',
      },
      imageId: null,
    }).catch(e => {
      console.warn('[inkwell/ipc] journal_image_mutation error:', e);
      warnDurability('Change journal unavailable — unsaved work at risk');
    });
  } else if (op === 'delete' || op === 'remove') {
    invokeTauri('journal_image_mutation', {
      op: 'delete',
      image: null,
      imageId: String(imgObj.id),
    }).catch(e => {
      console.warn('[inkwell/ipc] journal_image_mutation error:', e);
      warnDurability('Change journal unavailable — unsaved work at risk');
    });
  }
}

export function journalTextMutation(op, textObj) {
  if (!textObj) return;
  if (op === 'add' || op === 'upsert') {
    invokeTauri('journal_text_mutation', {
      op: 'upsert',
      text: {
        id: String(textObj.id),
        sheet: textObj.sheet || 0,
        x: textObj.x,
        y: textObj.y,
        text: textObj.text || '',
        font_size: textObj.fontSize || 16,
        color: textObj.color || '#141724',
        bold: !!textObj.bold,
        italic: !!textObj.italic,
        width: textObj.width || 120,
        height: textObj.height || 30,
      },
      textId: null,
    }).catch(e => {
      console.warn('[inkwell/ipc] journal_text_mutation error:', e);
      warnDurability('Change journal unavailable — unsaved work at risk');
    });
  } else if (op === 'delete' || op === 'remove') {
    invokeTauri('journal_text_mutation', {
      op: 'delete',
      text: null,
      textId: String(textObj.id),
    }).catch(e => {
      console.warn('[inkwell/ipc] journal_text_mutation error:', e);
      warnDurability('Change journal unavailable — unsaved work at risk');
    });
  }
}

// ---- Page Operations ----

export async function deletePage(pageIndex) {
  return await invokeTauri('delete_page', { index: pageIndex });
}

export async function reorderPages(fromIndex, toIndex) {
  return await invokeTauri('reorder_page', { fromIndex, toIndex });
}

export async function duplicatePage(pageIndex) {
  return await invokeTauri('duplicate_page', { index: pageIndex });
}

// ---- Native Stylus evdev Hardware Stream ----

export function initNativeStylusStream(onMessage) {
  if (typeof window === 'undefined') return;
  if (!window.__TAURI__ || !window.__TAURI__.core || !window.__TAURI__.core.invoke || !window.__TAURI__.core.Channel) {
    return;
  }

  try {
    const channel = new window.__TAURI__.core.Channel();
    channel.onmessage = (msg) => {
      if (typeof onMessage === 'function') {
        onMessage(msg);
      }
    };

    window.__TAURI__.core.invoke('start_stylus_stream', { channel })
      .catch(err => console.warn('[inkwell/ipc] Native stylus stream start error:', err));
  } catch (e) {
    console.warn('[inkwell/ipc] Native stylus stream init failed:', e);
  }
}

