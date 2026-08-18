/* ============================================================================
 * core/ipc.js — Tauri v2 Backend Transport & Bridge for Inkwell
 * Bridges JavaScript frontend to Rust backend commands and WAL journaler.
 * Keeps Tauri-specific invocation logic isolated from other domain modules.
 * ========================================================================== */

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

export async function savePdf(pathStr, overwrite = true, dryRun = false) {
  if (!pathStr) {
    return await invokeTauri('save_pdf_dialog', { overwrite, dryRun });
  }
  return await invokeTauri('save_pdf', { pathStr, overwrite, dryRun });
}

export async function newWhiteboard() {
  return await invokeTauri('create_blank_document');
}

export async function insertBlankPage(afterIndex = 0, widthPt = 595.0, heightPt = 842.0) {
  return await invokeTauri('insert_blank_page', { afterIndex, widthPt, heightPt });
}

export async function extractOutline() {
  return await invokeTauri('get_pdf_outline');
}

// ---- LOD Tile Rasterization ----

export async function fetchTile(pageIndex, rect, px) {
  return await invokeTauri('render_tile', { pageIndex, rect, px });
}

// ---- Vector Stroke Persistence ----

export async function commitStroke(sheet, tool, rgb, baseWidth, points) {
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
    }).catch(e => console.warn('[inkwell/ipc] journal_image_mutation error:', e));
  } else if (op === 'delete' || op === 'remove') {
    invokeTauri('journal_image_mutation', {
      op: 'delete',
      image: null,
      imageId: String(imgObj.id),
    }).catch(e => console.warn('[inkwell/ipc] journal_image_mutation error:', e));
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
    }).catch(e => console.warn('[inkwell/ipc] journal_text_mutation error:', e));
  } else if (op === 'delete' || op === 'remove') {
    invokeTauri('journal_text_mutation', {
      op: 'delete',
      text: null,
      textId: String(textObj.id),
    }).catch(e => console.warn('[inkwell/ipc] journal_text_mutation error:', e));
  }
}
