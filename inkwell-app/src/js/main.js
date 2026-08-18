/* ============================================================================
 * main.js — Main Application Bootstrap & UI Wiring for Inkwell
 * Pure lifecycle orchestrator: connects UI controls, commands, viewport & tools.
 * ========================================================================== */

import { state, $, on, emit } from './core/state.js';
import * as history from './core/history.js';
import * as commandsModule from './core/commands.js';
import * as documentOps from './core/document.js';
import * as clipboard from './core/clipboard.js';
import * as ipc from './core/ipc.js';

import * as compositor from './render/compositor.js';
import * as tiles from './render/tiles.js';
import * as overlays from './render/overlays.js';

import * as toolManager from './tools/tool-manager.js';
import * as penTool from './tools/pen.js';
import * as eraserTool from './tools/eraser.js';
import * as lassoTool from './tools/lasso.js';
import * as shapesTool from './tools/shapes.js';
import * as textTool from './tools/text.js';
import * as laserTool from './tools/laser.js';

import * as navigation from './workspace/navigation.js';
import * as scrollbar from './workspace/scrollbar.js';
import * as textSelection from './workspace/text-selection.js';

import * as toast from './ui/toast.js';
import * as toolbar from './ui/toolbar.js';
import * as drawers from './ui/drawers.js';
import * as radialMenu from './ui/radial-menu.js';
import * as contextMenu from './ui/context-menu.js';
import * as commandPalette from './ui/command-palette.js';

let _viewport = null;

export function getViewport() {
  return _viewport;
}

function handlePdfLoadResult(title, pathStr, res) {
  if (!res) return;
  const pageInfos = res.page_infos || (Array.isArray(res) ? res : []);
  const loadedStrokes = res.loaded_strokes || [];
  const loadedImages = res.loaded_images || [];
  const loadedTexts = res.loaded_texts || [];
  const outline = res.outline || [];

  state.outline = outline;
  state.currentDocPath = pathStr;
  state.currentDocTitle = title;

  documentOps.setDocument({
    pageInfos,
    strokes: loadedStrokes,
    images: loadedImages,
    textObjects: loadedTexts,
  });

  if (_viewport && pageInfos.length > 0) {
    _viewport.updateDocumentLayout(pageInfos);
    _viewport.fitPage(pageInfos[0].width_pt, pageInfos[0].height_pt, 'left');
  }

  $('welcomeDropzone') && $('welcomeDropzone').classList.add('hidden');
  navigation.goToPage(0, 'left', _viewport, false);
  scrollbar.updateDocScrollbar(_viewport);
  drawers.renderOutline();

  const totalRecovered = (res.recovered_strokes || 0) + (res.recovered_images || 0) + (res.recovered_texts || 0);
  if (totalRecovered > 0) {
    toast.showToast(`Restored ${totalRecovered} items from crash recovery log`, 'info');
  }
}

async function openFileTrigger() {
  const invoke = ipc.getInvoke();
  if (invoke) {
    try {
      const res = await ipc.openPdfDialog();
      if (res && res[0]) {
        const pathStr = res[0];
        const r = res[1] || {};
        const title = pathStr.split('\\').pop().split('/').pop();
        handlePdfLoadResult(title, pathStr, r);
        return;
      }
    } catch (e) {
      if (e !== 'CANCELLED' && e !== 'No file selected') {
        console.warn('[inkwell] openPdfDialog failed, falling back to input:', e);
      }
    }
  }
  $('pdfFileInput') && $('pdfFileInput').click();
}

async function createNewWhiteboard() {
  try {
    const res = await ipc.newWhiteboard();
    if (res) {
      handlePdfLoadResult('Untitled Note', null, res);
      toast.showToast('Created new whiteboard PDF', 'success');
    }
  } catch (e) {
    toast.showToast('Failed to create whiteboard: ' + e, 'error');
  }
}

function registerCoreCommands() {
  const reg = commandsModule.commands;

  // File commands
  reg.register({
    id: 'file.open',
    title: 'Open PDF Document',
    category: 'File',
    shortcut: 'Ctrl+O',
    execute: () => openFileTrigger(),
  });

  reg.register({
    id: 'file.newWhiteboard',
    title: 'New Whiteboard',
    category: 'File',
    shortcut: 'Ctrl+N',
    execute: () => createNewWhiteboard(),
  });

  reg.register({
    id: 'file.save',
    title: 'Save Document',
    category: 'File',
    shortcut: 'Ctrl+S',
    execute: async () => {
      try {
        state.isSaving = true;
        toolbar.updateSaveStatusUI('saving');
        await ipc.savePdf(state.currentDocPath, true, false);
        state.isDirty = false;
        toolbar.updateSaveStatusUI('saved');
        toast.showToast('Document saved successfully', 'success');
      } catch (e) {
        toolbar.updateSaveStatusUI('dirty');
        toast.showToast('Save failed: ' + e, 'error');
      } finally {
        state.isSaving = false;
      }
    },
  });

  // Edit commands
  reg.register({
    id: 'edit.undo',
    title: 'Undo',
    category: 'Edit',
    shortcut: 'Ctrl+Z',
    canExecute: () => history.canUndo(),
    execute: () => {
      documentOps.performUndo();
      compositor.redrawAll();
      toolbar.updateUndoRedoUI();
    },
  });

  reg.register({
    id: 'edit.redo',
    title: 'Redo',
    category: 'Edit',
    shortcut: ['Ctrl+Y', 'Ctrl+Shift+Z'],
    canExecute: () => history.canRedo(),
    execute: () => {
      documentOps.performRedo();
      compositor.redrawAll();
      toolbar.updateUndoRedoUI();
    },
  });

  reg.register({
    id: 'edit.copy',
    title: 'Copy Selection',
    category: 'Edit',
    shortcut: 'Ctrl+C',
    execute: () => {
      if (clipboard.copySelection()) {
        toast.showToast('Copied to clipboard', 'info');
      }
    },
  });

  reg.register({
    id: 'edit.cut',
    title: 'Cut Selection',
    category: 'Edit',
    shortcut: 'Ctrl+X',
    execute: () => {
      if (clipboard.cutSelection()) {
        compositor.redrawAll();
        toast.showToast('Cut to clipboard', 'info');
      }
    },
  });

  reg.register({
    id: 'edit.paste',
    title: 'Paste',
    category: 'Edit',
    shortcut: 'Ctrl+V',
    execute: () => {
      const activeSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
      if (clipboard.pasteClipboard(activeSheet)) {
        compositor.redrawAll();
        toast.showToast('Pasted objects', 'info');
      }
    },
  });

  reg.register({
    id: 'edit.duplicate',
    title: 'Duplicate Selection',
    category: 'Edit',
    shortcut: 'Ctrl+D',
    execute: () => {
      const activeSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
      if (clipboard.duplicateSelection(activeSheet)) {
        compositor.redrawAll();
      }
    },
  });

  reg.register({
    id: 'edit.delete',
    title: 'Delete Selection',
    category: 'Edit',
    shortcut: ['Delete', 'Backspace'],
    execute: () => {
      if (clipboard.deleteSelection()) {
        compositor.redrawAll();
      }
    },
  });

  reg.register({
    id: 'edit.selectAll',
    title: 'Select All on Page',
    category: 'Edit',
    shortcut: 'Ctrl+A',
    execute: () => {
      lassoTool.selectAllOnCurrentPage(_viewport);
    },
  });

  // Tool commands
  reg.register({ id: 'tool.pen', title: 'Fountain Pen', category: 'Tools', shortcut: 'P', execute: () => { toolManager.setTool('pen'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.highlighter', title: 'Highlighter', category: 'Tools', shortcut: 'M', execute: () => { toolManager.setTool('highlighter'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.eraser', title: 'Eraser', category: 'Tools', shortcut: 'E', execute: () => { toolManager.setTool('eraser'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.lasso', title: 'Lasso Select', category: 'Tools', shortcut: 'V', execute: () => { toolManager.setTool('lasso'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.shapes', title: 'Shapes', category: 'Tools', shortcut: 'U', execute: () => { toolManager.setTool('rect'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.text', title: 'Sticky Note', category: 'Tools', shortcut: 'T', execute: () => { toolManager.setTool('text'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.laser', title: 'Laser Pointer', category: 'Tools', shortcut: 'L', execute: () => { toolManager.setTool('laser'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.pan', title: 'Hand / Pan Canvas', category: 'Tools', shortcut: 'H', execute: () => { toolManager.setTool('pan'); toolbar.updateToolbarUI(); } });

  // Navigation commands
  reg.register({
    id: 'nav.nextPage',
    title: 'Next Page',
    category: 'Navigation',
    shortcut: ['PageDown', 'ArrowRight', ']'],
    execute: () => {
      const curSheet = state.drawingPane === 'right' ? state.rightSheet : state.leftSheet;
      navigation.goToPage(curSheet + 1, state.drawingPane || 'left', _viewport);
    },
  });

  reg.register({
    id: 'nav.prevPage',
    title: 'Previous Page',
    category: 'Navigation',
    shortcut: ['PageUp', 'ArrowLeft', '['],
    execute: () => {
      const curSheet = state.drawingPane === 'right' ? state.rightSheet : state.leftSheet;
      navigation.goToPage(curSheet - 1, state.drawingPane || 'left', _viewport);
    },
  });

  // View commands
  reg.register({
    id: 'view.toggleSplit',
    title: 'Toggle Split View',
    category: 'View',
    shortcut: 'Ctrl+\\',
    execute: () => {
      if (_viewport) {
        _viewport.splitMode = !_viewport.splitMode;
        $('btnRailSplit') && $('btnRailSplit').classList.toggle('active', _viewport.splitMode);
        compositor.scheduleRedrawTiles();
        compositor.redrawAll();
      }
    },
  });

  reg.register({
    id: 'view.toggleFullscreen',
    title: 'Toggle Fullscreen',
    category: 'View',
    shortcut: 'F11',
    execute: () => toolbar.toggleFullscreen(),
  });

  // Modal commands
  reg.register({
    id: 'modal.commandPalette',
    title: 'Command Palette',
    category: 'General',
    shortcut: ['Ctrl+K', 'Ctrl+Shift+P'],
    execute: () => commandPalette.openCommandPalette(),
  });
}

function bindAllUIEvents() {
  // File Open triggers
  $('btnHeaderOpen') && $('btnHeaderOpen').addEventListener('click', openFileTrigger);
  $('btnWelcomeOpen') && $('btnWelcomeOpen').addEventListener('click', openFileTrigger);
  $('btnOpen') && $('btnOpen').addEventListener('click', openFileTrigger);

  // File New triggers
  $('btnHeaderNewNote') && $('btnHeaderNewNote').addEventListener('click', createNewWhiteboard);
  $('btnWelcomeNewNote') && $('btnWelcomeNewNote').addEventListener('click', createNewWhiteboard);
  $('btnMoreNewNote') && $('btnMoreNewNote').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    createNewWhiteboard();
  });

  // Save triggers
  $('btnHeaderSave') && $('btnHeaderSave').addEventListener('click', () => commandsModule.commands.execute('file.save'));
  $('btnExportShare') && $('btnExportShare').addEventListener('click', () => commandsModule.commands.execute('file.save'));

  // File Input handler
  const fileInput = $('pdfFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const filePath = file.path || file.webkitRelativePath;
        if (filePath) {
          const r = await ipc.openPdf(filePath);
          handlePdfLoadResult(file.name, filePath, r);
          return;
        }
        const buf = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        const r2 = await ipc.openPdfBytes(file.name, bytes);
        handlePdfLoadResult(file.name, null, r2);
      } catch (err) {
        toast.showToast('Failed to open PDF: ' + err, 'error');
      }
    });
  }

  // Split View triggers
  const onSplitToggle = () => commandsModule.commands.execute('view.toggleSplit');
  $('btnRailSplit') && $('btnRailSplit').addEventListener('click', onSplitToggle);
  $('btnSplit') && $('btnSplit').addEventListener('click', onSplitToggle);
  $('btnZoomSplit') && $('btnZoomSplit').addEventListener('click', onSplitToggle);

  // Navigation buttons
  $('btnNavBack') && $('btnNavBack').addEventListener('click', () => navigation.navBack(_viewport));
  $('btnNavForward') && $('btnNavForward').addEventListener('click', () => navigation.navForward(_viewport));
  $('btnHeaderPrevPage') && $('btnHeaderPrevPage').addEventListener('click', () => commandsModule.commands.execute('nav.prevPage'));
  $('btnHeaderNextPage') && $('btnHeaderNextPage').addEventListener('click', () => commandsModule.commands.execute('nav.nextPage'));
  $('btnPrev') && $('btnPrev').addEventListener('click', () => commandsModule.commands.execute('nav.prevPage'));
  $('btnNext') && $('btnNext').addEventListener('click', () => commandsModule.commands.execute('nav.nextPage'));
  $('btnScrollTop') && $('btnScrollTop').addEventListener('click', () => navigation.goToPage(0, 'left', _viewport));

  // Modals & Popovers
  $('btnCmdPalette') && $('btnCmdPalette').addEventListener('click', () => commandPalette.openCommandPalette());
  $('btnMorePalette') && $('btnMorePalette').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    commandPalette.openCommandPalette();
  });
  $('btnMoreFullscreen') && $('btnMoreFullscreen').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    toolbar.toggleFullscreen();
  });

  // Insert Page form
  $('btnHeaderAddPage') && $('btnHeaderAddPage').addEventListener('click', () => {
    $('insertPageModal') && $('insertPageModal').classList.remove('hidden');
  });
  $('btnAddPage') && $('btnAddPage').addEventListener('click', () => {
    $('insertPageModal') && $('insertPageModal').classList.remove('hidden');
  });
  $('btnInsertBlank') && $('btnInsertBlank').addEventListener('click', () => {
    $('insertPageModal') && $('insertPageModal').classList.remove('hidden');
  });
  $('btnCloseInsertPageModal') && $('btnCloseInsertPageModal').addEventListener('click', () => {
    $('insertPageModal') && $('insertPageModal').classList.add('hidden');
  });
  $('btnCancelInsertPage') && $('btnCancelInsertPage').addEventListener('click', () => {
    $('insertPageModal') && $('insertPageModal').classList.add('hidden');
  });

  $('insertPageForm') && $('insertPageForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('insertPageModal') && $('insertPageModal').classList.add('hidden');
    try {
      const activeSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
      await ipc.insertBlankPage(activeSheet, 595.0, 842.0);
      documentOps.insertPage(activeSheet, { page_index: activeSheet + 1, width_pt: 595.0, height_pt: 842.0 });
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      navigation.goToPage(activeSheet + 1, 'left', _viewport);
      toast.showToast('Inserted blank page', 'success');
    } catch (err) {
      toast.showToast('Failed to insert page: ' + err, 'error');
    }
  });

  // Go To Page form
  $('goToPageForm') && $('goToPageForm').addEventListener('submit', e => {
    e.preventDefault();
    toolbar.closeGoToPageModal();
    const input = $('goToPageInput');
    const val = input ? parseInt(input.value, 10) : 1;
    if (!isNaN(val) && val >= 1) {
      navigation.goToPage(val - 1, 'left', _viewport);
    }
  });
  $('btnJumpFirstPage') && $('btnJumpFirstPage').addEventListener('click', () => {
    toolbar.closeGoToPageModal();
    navigation.goToPage(0, 'left', _viewport);
  });
  $('btnJumpLastPage') && $('btnJumpLastPage').addEventListener('click', () => {
    toolbar.closeGoToPageModal();
    if (state.pageInfos && state.pageInfos.length) {
      navigation.goToPage(state.pageInfos.length - 1, 'left', _viewport);
    }
  });

  // Clear current page ink
  const clearInk = () => {
    const activeSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
    documentOps.clearPageInk(activeSheet);
    compositor.redrawAll();
    toast.showToast(`Cleared ink on page ${activeSheet + 1}`, 'info');
  };
  $('btnMoreClearInk') && $('btnMoreClearInk').addEventListener('click', () => {
    $('moreOptionsMenu') && $('moreOptionsMenu').classList.add('hidden');
    clearInk();
  });
  $('btnDocInfoClearInk') && $('btnDocInfoClearInk').addEventListener('click', clearInk);

  // Drag and Drop PDF
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;
    try {
      const filePath = file.path;
      if (filePath) {
        const r = await ipc.openPdf(filePath);
        handlePdfLoadResult(file.name, filePath, r);
        return;
      }
      const buf = await file.arrayBuffer();
      const r2 = await ipc.openPdfBytes(file.name, Array.from(new Uint8Array(buf)));
      handlePdfLoadResult(file.name, null, r2);
    } catch (err) {
      toast.showToast('Failed to open dropped PDF: ' + err, 'error');
    }
  });
}

function attachPointerHandlers(wetCanvas) {
  if (!wetCanvas) return;

  function localXY(e) {
    const pane = compositor.paneForEvent(e);
    const r = compositor.getStageRect() || wetCanvas.getBoundingClientRect();
    const wx = _viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top, pane);
    return { ptWorld: wx, pane, screenPt: [e.clientX - r.left, e.clientY - r.top] };
  }

  wetCanvas.addEventListener('pointerdown', e => {
    const { ptWorld, pane, screenPt } = localXY(e);
    const tool = state.activeTool || 'pen';

    if (tool === 'pen' || tool === 'highlighter') {
      penTool.onPenDown(e, ptWorld, pane, _viewport);
    } else if (tool === 'eraser') {
      eraserTool.onEraserDown(e, ptWorld, pane, _viewport);
    } else if (tool === 'lasso') {
      lassoTool.onLassoDown(e, ptWorld, screenPt, pane, _viewport);
    } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler') {
      shapesTool.onShapeDown(e, ptWorld, pane, _viewport);
    } else if (tool === 'laser') {
      laserTool.onLaserDown(e, ptWorld, pane, _viewport);
    } else if (tool === 'text') {
      textTool.onTextToolClick(e, ptWorld, pane, _viewport);
    }
  });

  const moveEvt = ('onpointerrawupdate' in window) ? 'pointerrawupdate' : 'pointermove';
  wetCanvas.addEventListener(moveEvt, e => {
    const { ptWorld, pane, screenPt } = localXY(e);
    const tool = state.activeTool || 'pen';

    if (tool === 'pen' || tool === 'highlighter') {
      penTool.onPenMove(e, ptWorld, pane, _viewport);
    } else if (tool === 'eraser') {
      eraserTool.onEraserMove(e, ptWorld, pane, _viewport);
    } else if (tool === 'lasso') {
      lassoTool.onLassoMove(e, ptWorld, screenPt, pane, _viewport);
    } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler') {
      shapesTool.onShapeMove(e, ptWorld, pane, _viewport);
    } else if (tool === 'laser') {
      laserTool.onLaserMove(e, ptWorld, pane, _viewport);
    }
  });

  wetCanvas.addEventListener('pointerup', e => {
    const tool = state.activeTool || 'pen';

    if (tool === 'pen' || tool === 'highlighter') {
      penTool.onPenUp(e, _viewport);
    } else if (tool === 'eraser') {
      eraserTool.onEraserUp();
    } else if (tool === 'lasso') {
      lassoTool.onLassoUp(e, _viewport);
    } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler') {
      shapesTool.onShapeUp(e, _viewport);
    } else if (tool === 'laser') {
      laserTool.onLaserUp();
    }
  });

  wetCanvas.addEventListener('pointercancel', () => {
    penTool.onPenCancel();
    eraserTool.onEraserUp();
    laserTool.clearLaser();
  });
}

function attachKeyboardShortcuts() {
  window.addEventListener('keydown', e => {
    const isTyping = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (isTyping) return;

    // Spring-loaded modifier keys (e.g. holding 'e' or space)
    toolManager.handleSpringKeyDown(e.key);

    const cmd = commandsModule.commands.findMatchingShortcut(e);
    if (cmd) {
      e.preventDefault();
      commandsModule.commands.execute(cmd.id);
    }
  });

  window.addEventListener('keyup', e => {
    toolManager.handleSpringKeyUp(e.key);
  });
}

// ---- Application Bootstrap Lifecycle ----

window.addEventListener('DOMContentLoaded', async () => {
  const tilesCanvas = $('tiles');
  const dryCanvas = $('dry');
  const wetCanvas = $('wet');

  if (typeof window.ViewportManager === 'function') {
    _viewport = new window.ViewportManager(() => {
      navigation.syncActivePagesFromViewport(_viewport);
      compositor.scheduleRedrawTiles();
      compositor.scheduleRedrawAll();
      scrollbar.updateDocScrollbar(_viewport);
    });
    _viewport.attachListeners($('stage'));
  }

  compositor.initCompositor({ tilesCanvas, dryCanvas, wetCanvas, viewport: _viewport });
  compositor.resize();

  drawers.setGoToPageCallback((pageIdx, pane) => navigation.goToPage(pageIdx, pane, _viewport));
  drawers.initDrawers();

  registerCoreCommands();
  toolbar.initToolbar(_viewport);
  scrollbar.initDocScrollbar(_viewport);
  radialMenu.initRadialMenu();
  contextMenu.initContextMenu();
  commandPalette.initCommandPalette();

  bindAllUIEvents();
  attachPointerHandlers(wetCanvas);
  attachKeyboardShortcuts();

  window.addEventListener('resize', () => compositor.resize());
  window.addEventListener('scroll', () => compositor.updateStageRect(), { passive: true });

  // Passive state listeners
  on('toast', payload => toast.showToast(payload.message, payload.type));
  on('toolChanged', () => toolbar.updateToolbarUI());
  on('historyChanged', () => toolbar.updateUndoRedoUI());
  on('pageChanged', payload => {
    const pageDisplay = $('pageNumDisplay');
    if (pageDisplay) {
      pageDisplay.textContent = `Page ${payload.pageIndex + 1} / ${payload.totalPages || 1}`;
    }
    scrollbar.updateDocScrollbar(_viewport);
  });

  // Global compatibility bridges
  window.undo = () => commandsModule.commands.execute('edit.undo');
  window.redo = () => commandsModule.commands.execute('edit.redo');
  window.showToast = toast.showToast;
  window.scheduleRedrawTiles = compositor.scheduleRedrawTiles;
  window.scheduleRedrawAll = compositor.scheduleRedrawAll;
  window.redrawAll = compositor.redrawAll;
});
