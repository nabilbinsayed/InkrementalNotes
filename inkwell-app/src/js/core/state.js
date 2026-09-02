/* ============================================================================
 * core/state.js — Central document, workspace, and UI state for Inkwell
 * ========================================================================== */

export const $ = id => document.getElementById(id);

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Lightweight Notification Event Emitter (strictly for UI notifications, not business control flow)
const _listeners = new Map();

export function on(event, callback) {
  if (!_listeners.has(event)) {
    _listeners.set(event, new Set());
  }
  _listeners.get(event).add(callback);
  return () => off(event, callback);
}

export function off(event, callback) {
  const set = _listeners.get(event);
  if (set) {
    set.delete(callback);
    if (set.size === 0) _listeners.delete(event);
  }
}

export function emit(event, data) {
  const set = _listeners.get(event);
  if (set) {
    for (const cb of set) {
      try {
        cb(data);
      } catch (err) {
        console.error(`[inkwell/state] Error in event listener for '${event}':`, err);
      }
    }
  }
}

let _lastToastAt = 0;
export function warnDurability(message) {
  const now = Date.now();
  if (now - _lastToastAt < 4000) return; // dedupe storms
  _lastToastAt = now;
  emit('toast', { message, type: 'error' });
}

export const state = {
  // Tool Modes & Properties
  activeTool: 'pen',     // 'pen', 'highlighter', 'eraser', 'lasso', 'ruler', 'rect', 'ellipse', 'laser', 'text', 'textSelect', 'pan'
  prevTool: 'pen',        // restored after spring-loaded key release
  lastActiveTool: 'eraser', // previously used tool for Space quick-toggle
  lastUsedTool: 'rect',
  springKey: null,        // which key is spring-held right now
  isSpacePressed: false,  // whether spacebar is currently held down
  spaceDownTime: null,    // performance.now() timestamp when spacebar was pressed
  spaceToolBefore: null,  // activeTool prior to spacebar hold
  spaceDidPan: false,     // whether user dragged/panned while spacebar was held
  color: [0.08, 0.09, 0.14],
  penColor: [0.08, 0.09, 0.14],
  highlighterColor: [0.99, 0.93, 0.28],
  textColor: '#141724',
  shapesColor: [0.08, 0.09, 0.14],
  penWidth: 1.6,
  highlighterWidth: 16.0,
  baseWidth: 1.6,

  // Document Objects (Authoritative Data Model)
  strokes: [],           // [{id, kind, rgb, base_width, points[], deleted, sheet}, ...]
  images: [],            // [{id, sheet, x, y, width, height, dataUrl, _el, deleted}, ...]
  textObjects: [],       // [{id, sheet, x, y, text, fontSize, color, bold, italic, width, height, deleted}, ...]
  pageTextSpans: {},     // { [sheet: number]: [{ text, rect: [x0, y0, x1, y1], page_index }] }
  pageTextData: {},      // { [sheet: number]: { page_index, text, lines[], chars[], spans[] } }
  pageTextLoading: {},   // { [sheet: number]: Promise<any> }
  pageInfos: [],         // [{page_index, width_pt, height_pt, template?}, ...]
  outline: [],           // hierarchical outline [{ title, page_index, children }]
  bookmarks: [],         // [{ id, page, label, createdAt }]

  // Selection State
  selectedStrokes: [],
  selectedImages: [],
  selectedTextObjects: [],
  selectedTextSpans: [],
  selectedTextString: '',
  textSelection: null,   // { sheet, startCharIdx, endCharIdx, text, rects[], chars[] }
  textSelectAnchor: null, // { sheet, charIndex, time, clickCount }
  textSelectPending: null, // { sheet, px, py, currentPx, currentPy, time, clickCount, isDown }
  isSelectingText: false,
  activeTextEditorObj: null,

  // Workspace, Panes & Sheets
  leftSheet: 0,          // active PDF page index for left pane
  rightSheet: 0,         // active PDF page index for right pane
  drawingPane: 'left',
  dpr: 1,
  inkVisible: true,
  continuousScroll: true,

  // Transient Gesture / Interaction State
  cur: null,             // current in-progress Stroke instance
  isErasing: false,
  handDownPt: null,
  handStartWorldPt: null,
  shapeStart: null,
  shapeEnd: null,
  shapeKind: null,       // 'rect' | 'ellipse' | 'line'
  lassoPath: null,       // [[wx, wy], ...] for freeform lasso polygon
  transformMode: null,   // 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
  transformStartPt: null,
  transformInitialBounds: null,
  transformInitialStrokes: null,
  transformInitialImages: null,
  transformInitialTextObjects: null,
  laserPos: null,
  laserTimer: null,
  laserPoints: [],
  streamline: null,

  // Tabs & Multi-Document State
  activeTabId: null,
  tabs: [],              // [{id, title, pathStr, leftSheet, rightSheet, isDirty}]
  recentFiles: [],
  isWelcomeMode: true,

  // Drawers & Navigation
  activeDrawer: null,    // 'thumbnails' | 'outline' | 'bookmarks' | 'search' | 'docinfo' | 'layers' | 'settings'
  navHistory: [],
  navIndex: -1,

  // Search
  searchQuery: '',
  searchResults: [],
  activeSearchMatch: 0,
  isSearching: false,

  // Persistence & Save State (History stacks moved to history.js)
  isDirty: false,
  isSaving: false,
  autosaveDelayMs: parseInt(localStorage.getItem('inkwell_autosave_delay') || '0', 10),
  autosaveTimer: null,
  lastSavedAt: null,
};
