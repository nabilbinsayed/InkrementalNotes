/* ============================================================================
 * core/history.js — Transaction-based Undo / Redo manager for Inkwell
 * Owns undo/redo stacks privately; does not duplicate state in state.js
 * ========================================================================== */

const MAX_HISTORY_DEPTH = 100;

const _undoStack = [];
const _redoStack = [];

let _uiUpdateCallback = null;

export function setUndoRedoUiCallback(cb) {
  _uiUpdateCallback = cb;
}

export function pushTransaction(tx) {
  if (!tx || !tx.type) return;
  _undoStack.push(tx);
  if (_undoStack.length > MAX_HISTORY_DEPTH) {
    _undoStack.shift();
  }
  _redoStack.length = 0; // Clear redo on new action
  notifyHistoryChange();
}

export function canUndo() {
  return _undoStack.length > 0;
}

export function canRedo() {
  return _redoStack.length > 0;
}

export function peekUndo() {
  return _undoStack.length ? _undoStack[_undoStack.length - 1] : null;
}

export function popUndo() {
  if (!_undoStack.length) return null;
  const tx = _undoStack.pop();
  notifyHistoryChange();
  return tx;
}

export function pushRedo(tx) {
  if (!tx) return;
  _redoStack.push(tx);
  notifyHistoryChange();
}

export function popRedo() {
  if (!_redoStack.length) return null;
  const tx = _redoStack.pop();
  notifyHistoryChange();
  return tx;
}

export function pushUndoRaw(tx) {
  if (!tx) return;
  _undoStack.push(tx);
  if (_undoStack.length > MAX_HISTORY_DEPTH) {
    _undoStack.shift();
  }
  notifyHistoryChange();
}

export function clearHistory() {
  _undoStack.length = 0;
  _redoStack.length = 0;
  notifyHistoryChange();
}

export function getHistoryLengths() {
  return { undo: _undoStack.length, redo: _redoStack.length };
}

function notifyHistoryChange() {
  if (typeof _uiUpdateCallback === 'function') {
    try {
      _uiUpdateCallback({ canUndo: canUndo(), canRedo: canRedo() });
    } catch (e) {
      console.warn('[inkwell/history] UI update callback error:', e);
    }
  }
}
