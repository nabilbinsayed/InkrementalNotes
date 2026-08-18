/* ============================================================================
 * tools/text.js — Interactive Sticky Notes & Inline Text Editor Adapter for Inkwell
 * Creates editable floating keyboard text notes and updates document text objects.
 * ========================================================================== */

import { state, $, emit } from '../core/state.js';
import * as documentOps from '../core/document.js';
import * as ipc from '../core/ipc.js';
import * as compositor from '../render/compositor.js';

let _activeEditingObj = null;
let _isNewNote = false;

export function onTextToolClick(e, ptWorld, pane, viewport) {
  const pageCoord = viewport.worldToPage(ptWorld[0], ptWorld[1]);
  const activeSheet = pageCoord.sheet;
  const pl = viewport.getPageLayout(activeSheet);

  const newTextObj = {
    id: 'txt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    sheet: activeSheet,
    x: ptWorld[0] - pl.x,
    y: ptWorld[1] - pl.y,
    text: '',
    fontSize: 16,
    color: state.textColor || '#141724',
    bold: false,
    italic: false,
    width: 140,
    height: 32,
    deleted: false,
  };

  _isNewNote = true;
  startEditing(newTextObj, viewport, pane);
}

export function startEditing(textObj, viewport, pane = 'left') {
  _activeEditingObj = textObj;
  const editor = $('inlineTextEditor');
  const textarea = $('inlineTextarea');
  if (!editor || !textarea || !viewport) return;

  const pl = viewport.getPageLayout(textObj.sheet || 0);
  const [sx, sy] = viewport.worldToScreen(pl.x + textObj.x, pl.y + textObj.y, pane);

  editor.style.left = `${sx}px`;
  editor.style.top = `${sy}px`;
  editor.classList.remove('hidden');

  textarea.value = textObj.text || '';
  textarea.style.fontSize = `${textObj.fontSize || 16}px`;
  textarea.style.color = textObj.color || '#141724';
  textarea.style.fontWeight = textObj.bold ? 'bold' : 'normal';
  textarea.style.fontStyle = textObj.italic ? 'italic' : 'normal';

  requestAnimationFrame(() => {
    textarea.focus();
    textarea.select();
  });
}

export function commitEditing() {
  const editor = $('inlineTextEditor');
  const textarea = $('inlineTextarea');
  if (!editor || !textarea || !_activeEditingObj) return;

  const val = textarea.value.trim();
  editor.classList.add('hidden');

  if (val.length === 0) {
    if (!_isNewNote) {
      documentOps.deleteTextObject(_activeEditingObj.id, { recordHistory: true });
      ipc.journalTextMutation('delete', _activeEditingObj);
    }
  } else {
    _activeEditingObj.text = val;
    documentOps.upsertTextObject(_activeEditingObj, { recordHistory: true, isNew: _isNewNote });
    ipc.journalTextMutation('upsert', _activeEditingObj);
  }

  _activeEditingObj = null;
  _isNewNote = false;
  compositor.redrawAll();
}

export function cancelEditing() {
  const editor = $('inlineTextEditor');
  if (editor) editor.classList.add('hidden');
  _activeEditingObj = null;
  _isNewNote = false;
}
