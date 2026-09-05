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
  if (typeof window.emitZoomChanged === 'function' && _viewport) {
    window.emitZoomChanged(_viewport);
  }

  const totalRecovered = (res.recovered_strokes || 0) + (res.recovered_images || 0) + (res.recovered_texts || 0);
  if (totalRecovered > 0) {
    toast.showToast(`Restored ${totalRecovered} items from crash recovery log`, 'info');
  }

  const warm = () => {
    const t0 = performance.now();
    for (const s of state.strokes || []) {
      if (!s.deleted && !s._cachedPath2D && window.Ink && typeof window.Ink.getPath2D === 'function') {
        s._cachedPath2D = window.Ink.getPath2D(s);
        if (typeof window.Ink.computeStrokeBbox === 'function') {
          s.bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
        }
        if (performance.now() - t0 > 8) {
          setTimeout(warm, 32);
          return;
        }
      }
    }
  };
  setTimeout(warm, 200);
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

export function friendlyError(e) {
  if (typeof e === 'string') {
    if (/CANCELLED/i.test(e)) return null;
    if (/lock|denied|permission/i.test(e)) return 'File is locked — close it in other apps and retry.';
    if (/No document open|No PDF/i.test(e)) return 'Open a document first.';
    return e;
  }
  return (e && e.message) ? e.message : 'Unexpected error';
}

async function createNewWhiteboard() {
  try {
    const res = await ipc.newWhiteboard();
    if (res) {
      handlePdfLoadResult('Untitled Note', null, res);
      toast.showToast('Created new whiteboard PDF', 'success');
      return;
    }
  } catch (e) {
    const msg = friendlyError(e);
    if (msg) toast.showToast('Failed to create whiteboard: ' + msg, 'error');
  }
  // Immediate client fallback so document layout is active on first render
  handlePdfLoadResult('Untitled Note', null, {
    page_infos: [{ page_index: 0, width_pt: 842.0, height_pt: 595.0, template: 'blank' }],
    loaded_strokes: [],
    loaded_images: [],
    loaded_texts: [],
    outline: [],
  });
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
        await ipc.savePdf(state.currentDocPath, state.strokes, state.images, state.textObjects);
        state.isDirty = false;
        toolbar.updateSaveStatusUI('saved');
        toast.showToast('Document saved successfully', 'success');
      } catch (e) {
        toolbar.updateSaveStatusUI('dirty');
        const msg = friendlyError(e);
        if (msg) toast.showToast('Save failed: ' + msg, 'error');
      } finally {
        state.isSaving = false;
      }
    },
  });

  reg.register({
    id: 'file.exportPdf',
    title: 'Export As New Copy...',
    category: 'File',
    shortcut: 'Ctrl+Shift+S',
    execute: async () => {
      try {
        state.isSaving = true;
        toolbar.updateSaveStatusUI('saving');
        await ipc.savePdf(null, state.strokes, state.images, state.textObjects);
        toolbar.updateSaveStatusUI('saved');
        toast.showToast('Document exported successfully', 'success');
      } catch (e) {
        const msg = friendlyError(e);
        if (msg) toast.showToast('Export failed: ' + msg, 'error');
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
      if ((state.activeTool === 'textSelect' || state.activeTool === 'textselect') && state.selectedTextString && textSelection.copySelectedPdfText()) {
        return;
      }
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
  reg.register({ id: 'tool.textSelect', title: 'Text Selection', category: 'Tools', shortcut: 'S', execute: () => { toolManager.setTool('textSelect'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.laser', title: 'Laser Pointer', category: 'Tools', shortcut: 'L', execute: () => { toolManager.setTool('laser'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.pan', title: 'Hand / Pan Canvas', category: 'Tools', shortcut: 'H', execute: () => { toolManager.setTool('pan'); toolbar.updateToolbarUI(); } });
  reg.register({ id: 'tool.palette', title: 'Ink Color & Width Palette', category: 'Tools', shortcut: 'C', execute: () => { toolbar.togglePropPopover(); } });

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
        const cluster = $('splitPageNavCluster');
        if (cluster) {
          if (_viewport.splitMode) cluster.classList.remove('hidden');
          else cluster.classList.add('hidden');
        }
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

  reg.register({
    id: 'view.zoomIn',
    title: 'Zoom In',
    category: 'View',
    shortcut: ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl++'],
    execute: () => {
      if (_viewport) {
        _viewport.zoomIn([_viewport.stageW / 2, _viewport.stageH / 2], 'left');
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
      }
    },
  });

  reg.register({
    id: 'view.zoomOut',
    title: 'Zoom Out',
    category: 'View',
    shortcut: 'Ctrl+-',
    execute: () => {
      if (_viewport) {
        _viewport.zoomOut([_viewport.stageW / 2, _viewport.stageH / 2], 'left');
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
      }
    },
  });

  reg.register({
    id: 'view.fitPage',
    title: 'Fit Page to Window',
    category: 'View',
    shortcut: 'Ctrl+0',
    execute: () => {
      if (_viewport && state.pageInfos && state.pageInfos[0]) {
        _viewport.fitPage(state.pageInfos[0].width_pt, state.pageInfos[0].height_pt, 'left');
        if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
      }
    },
  });

  // Modal commands
  reg.register({
    id: 'modal.commandPalette',
    title: 'Command Palette',
    category: 'General',
    shortcut: ['Ctrl+K', 'Ctrl+Shift+P'],
    execute: () => commandPalette.openCommandPalette(),
  });

  reg.register({
    id: 'modal.preferences',
    title: 'Preferences',
    category: 'General',
    shortcut: 'Ctrl+,',
    execute: () => toolbar.openSettingsModal(),
  });

  reg.register({
    id: 'modal.shortcuts',
    title: 'Keyboard Shortcuts',
    category: 'General',
    shortcut: ['?', 'F1'],
    execute: () => {
      $('shortcutsModal') && $('shortcutsModal').classList.remove('hidden');
    },
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
        const msg = friendlyError(err);
        if (msg) toast.showToast('Failed to open PDF: ' + msg, 'error');
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
  $('btnCanvasPrevPage') && $('btnCanvasPrevPage').addEventListener('click', () => commandsModule.commands.execute('nav.prevPage'));
  $('btnCanvasNextPage') && $('btnCanvasNextPage').addEventListener('click', () => commandsModule.commands.execute('nav.nextPage'));
  $('btnLeftPanePrev') && $('btnLeftPanePrev').addEventListener('click', () => {
    const cur = _viewport ? _viewport.getActivePageInView('left') : 0;
    navigation.goToPage(cur - 1, 'left', _viewport);
  });
  $('btnLeftPaneNext') && $('btnLeftPaneNext').addEventListener('click', () => {
    const cur = _viewport ? _viewport.getActivePageInView('left') : 0;
    navigation.goToPage(cur + 1, 'left', _viewport);
  });
  $('btnRightPanePrev') && $('btnRightPanePrev').addEventListener('click', () => {
    const cur = _viewport ? _viewport.getActivePageInView('right') : 0;
    navigation.goToPage(cur - 1, 'right', _viewport);
  });
  $('btnRightPaneNext') && $('btnRightPaneNext').addEventListener('click', () => {
    const cur = _viewport ? _viewport.getActivePageInView('right') : 0;
    navigation.goToPage(cur + 1, 'right', _viewport);
  });
  $('btnScrollTop') && $('btnScrollTop').addEventListener('click', () => navigation.goToPage(0, 'left', _viewport));

  // Custom Zoom
  const applyCustomZoom = () => {
    const input = $('inputCustomZoom');
    if (!input || !_viewport) return;
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) {
      const targetZoom = Math.max(0.15, Math.min(10.0, val / 100));
      const stageRect = compositor.getStageRect() || { width: 800, height: 600 };
      _viewport.setZoom(targetZoom, [stageRect.width / 2, stageRect.height / 2], 'left');
      if (typeof window.emitZoomChanged === 'function') window.emitZoomChanged(_viewport);
      toolbar.closeZoomMenu();
    }
  };
  $('btnApplyCustomZoom') && $('btnApplyCustomZoom').addEventListener('click', applyCustomZoom);
  $('inputCustomZoom') && $('inputCustomZoom').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyCustomZoom();
  });

  // Autosave delay setting
  const selAutosave = $('selectAutosaveDelay');
  if (selAutosave) {
    selAutosave.value = String(state.autosaveDelayMs || 0);
    selAutosave.addEventListener('change', () => {
      const val = parseInt(selAutosave.value, 10) || 0;
      state.autosaveDelayMs = val;
      localStorage.setItem('inkwell_autosave_delay', String(val));
    });
  }

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

  // Insert Page modal and customization
  function openInsertPageModal() {
    const modal = $('insertPageModal');
    if (!modal) return;
    const curSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;

    const posSel = $('insertPositionSelect');
    if (posSel) {
      if (posSel.options[0]) posSel.options[0].textContent = `After Current Page (${curSheet + 1})`;
      if (posSel.options[1]) posSel.options[1].textContent = `Before Current Page (${curSheet + 1})`;
      posSel.value = 'after_current';
    }

    const sizeSel = $('insertPaperSizeSelect');
    if (sizeSel) sizeSel.value = 'match_current';
    const customRow = $('customDimRow');
    if (customRow) customRow.classList.add('hidden');

    const portraitRadio = document.querySelector('input[name="pageOrientation"][value="portrait"]');
    if (portraitRadio) portraitRadio.checked = true;

    const templateSel = $('insertTemplateSelect');
    if (templateSel) templateSel.value = 'blank';

    modal.classList.remove('hidden');
  }

  function closeInsertPageModal() {
    const modal = $('insertPageModal');
    if (modal) modal.classList.add('hidden');
  }

  $('btnHeaderAddPage') && $('btnHeaderAddPage').addEventListener('click', openInsertPageModal);
  $('btnAddPage') && $('btnAddPage').addEventListener('click', openInsertPageModal);
  $('btnInsertBlank') && $('btnInsertBlank').addEventListener('click', openInsertPageModal);
  $('btnCloseInsertPageModal') && $('btnCloseInsertPageModal').addEventListener('click', closeInsertPageModal);
  $('btnCancelInsertPage') && $('btnCancelInsertPage').addEventListener('click', closeInsertPageModal);
  $('insertPageModal') && $('insertPageModal').addEventListener('click', e => {
    if (e.target === $('insertPageModal')) closeInsertPageModal();
  });

  $('insertPaperSizeSelect') && $('insertPaperSizeSelect').addEventListener('change', e => {
    const customRow = $('customDimRow');
    if (customRow) {
      if (e.target.value === 'custom') {
        customRow.classList.remove('hidden');
      } else {
        customRow.classList.add('hidden');
      }
    }
  });

  $('insertPageForm') && $('insertPageForm').addEventListener('submit', async e => {
    e.preventDefault();
    closeInsertPageModal();
    try {
      const curSheet = _viewport ? _viewport.getActivePageInView(state.drawingPane || 'left') : 0;
      const totalPages = state.pageInfos ? state.pageInfos.length : 0;
      const curPageInfo = (state.pageInfos && state.pageInfos[curSheet]) || { width_pt: 595.0, height_pt: 842.0 };

      // 1. Resolve base width and height in points
      const sizePreset = $('insertPaperSizeSelect') ? $('insertPaperSizeSelect').value : 'match_current';
      let width = 595.0;
      let height = 842.0;

      switch (sizePreset) {
        case 'match_current':
          width = curPageInfo.width_pt || 595.0;
          height = curPageInfo.height_pt || 842.0;
          break;
        case 'a4':
          width = 595.0; height = 842.0;
          break;
        case 'letter':
          width = 612.0; height = 792.0;
          break;
        case 'a3':
          width = 842.0; height = 1191.0;
          break;
        case 'legal':
          width = 612.0; height = 1008.0;
          break;
        case 'widescreen':
          width = 960.0; height = 540.0;
          break;
        case 'custom': {
          const wInput = parseFloat($('customPageWidth') ? $('customPageWidth').value : '595');
          const hInput = parseFloat($('customPageHeight') ? $('customPageHeight').value : '842');
          width = !isNaN(wInput) && wInput >= 72 ? wInput : 595.0;
          height = !isNaN(hInput) && hInput >= 72 ? hInput : 842.0;
          break;
        }
      }

      // 2. Resolve orientation
      const orientation = document.querySelector('input[name="pageOrientation"]:checked')?.value || 'portrait';
      if (orientation === 'landscape' && width < height) {
        const tmp = width; width = height; height = tmp;
      } else if (orientation === 'portrait' && width > height) {
        const tmp = width; width = height; height = tmp;
      }

      // 3. Resolve template
      const template = $('insertTemplateSelect') ? $('insertTemplateSelect').value : 'blank';

      // 4. Resolve target insertion index
      const posChoice = $('insertPositionSelect') ? $('insertPositionSelect').value : 'after_current';
      let targetIndex = curSheet + 1;
      if (posChoice === 'before_current') {
        targetIndex = curSheet;
      } else if (posChoice === 'document_start') {
        targetIndex = 0;
      } else if (posChoice === 'document_end') {
        targetIndex = totalPages;
      }

      // 5. Execute insertion
      await ipc.insertBlankPage(targetIndex, width, height);
      const newPageInfo = {
        page_index: targetIndex,
        width_pt: width,
        height_pt: height,
        template,
      };
      documentOps.insertPageAtIndex(targetIndex, newPageInfo);
      if (_viewport) _viewport.updateDocumentLayout(state.pageInfos);
      navigation.goToPage(targetIndex, 'left', _viewport);
      drawers.renderThumbnails();
      compositor.redrawAll();

      const templateName = $('insertTemplateSelect') && $('insertTemplateSelect').selectedOptions[0]
        ? $('insertTemplateSelect').selectedOptions[0].textContent
        : template;
      toast.showToast(`Inserted page ${targetIndex + 1} (${templateName})`, 'success');
    } catch (err) {
      const msg = friendlyError(err);
      if (msg) toast.showToast('Failed to insert page: ' + msg, 'error');
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

  // Text selection popover actions
  $('btnTextCopy') && $('btnTextCopy').addEventListener('click', () => {
    if (textSelection.copySelectedPdfText()) {
      toast.showToast('Copied text to clipboard', 'info');
    }
    const pop = $('textSelectionPopover');
    if (pop) pop.classList.add('hidden');
  });

  $('btnTextSearch') && $('btnTextSearch').addEventListener('click', () => {
    const text = state.selectedTextString || (state.textSelection && state.textSelection.text);
    if (text) {
      drawers.openSearchWithQuery(text.trim());
    }
    const pop = $('textSelectionPopover');
    if (pop) pop.classList.add('hidden');
  });

  $('btnHeaderFind') && $('btnHeaderFind').addEventListener('click', () => {
    drawers.openDrawer('search');
    const input = $('drawerSearchInput');
    if (input) input.focus();
  });

  // Sticky note inline text editor
  const textarea = $('inlineTextarea');
  if (textarea) {
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        textTool.cancelEditing();
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        textTool.commitEditing();
      }
    });
    textarea.addEventListener('blur', () => {
      textTool.commitEditing();
    });
  }

  const tb = $('inlineTextToolbar');
  if (tb) {
    tb.addEventListener('mousedown', (e) => e.preventDefault());
    tb.addEventListener('pointerdown', (e) => e.preventDefault());
  }

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
      const msg = friendlyError(err);
      if (msg) toast.showToast('Failed to open dropped PDF: ' + msg, 'error');
    }
  });

  // Modal focus trapping and backdrop dismissal
  initModalFocusTrap();
}

function updateTextSelectionPopover() {
  const pop = $('textSelectionPopover');
  if (!pop) return;
  const sel = state.textSelection;
  if (sel && sel.text && sel.text.trim() && (state.activeTool === 'textSelect' || state.activeTool === 'textselect')) {
    const anchorRect = sel.rects && sel.rects.length > 0 ? sel.rects[sel.rects.length - 1].rect : null;
    if (anchorRect && _viewport) {
      const pl = _viewport.getPageLayout(sel.sheet);
      const [sx, sy] = _viewport.worldToScreen(pl.x + anchorRect[2], pl.y + anchorRect[3], 'left');
      pop.style.left = Math.max(10, Math.min(sx, window.innerWidth - 220)) + 'px';
      pop.style.top = (sy + 12) + 'px';
    }
    pop.classList.remove('hidden');
  } else {
    pop.classList.add('hidden');
  }
}

let _panState = {
  isDown: false,
  startClientX: 0,
  startClientY: 0,
  startPanX: 0,
  startPanY: 0,
  pane: 'left',
};

function attachPointerHandlers(wetCanvas) {
  if (!wetCanvas) return;

  function localXY(e) {
    const pane = compositor.paneForEvent(e);
    const r = compositor.getStageRect() || wetCanvas.getBoundingClientRect();
    const wx = _viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top, pane);
    return { ptWorld: wx, pane, screenPt: [e.clientX - r.left, e.clientY - r.top] };
  }

  wetCanvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    contextMenu.showContextMenu(e.clientX, e.clientY);
  });

  const stage = $('stage');
  if (stage) {
    stage.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu.showContextMenu(e.clientX, e.clientY);
    });
  }

  wetCanvas.addEventListener('pointerdown', e => {
    compositor.updateStageRect();
    toolbar.hidePropPopover();
    try { wetCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    const { ptWorld, pane, screenPt } = localXY(e);
    const tool = state.activeTool || 'pen';

    if (tool !== 'textSelect' && tool !== 'textselect') {
      const pop = $('textSelectionPopover');
      if (pop) pop.classList.add('hidden');
    }

    if (tool === 'pan') {
      const isRight = (pane === 'right' && _viewport && _viewport.splitMode);
      _panState = {
        isDown: true,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: _viewport ? (isRight ? _viewport.rightPanX : _viewport.panX) : 0,
        startPanY: _viewport ? (isRight ? _viewport.rightPanY : _viewport.panY) : 0,
        pane,
      };
    } else if (tool === 'pen' || tool === 'highlighter') {
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
    } else if (tool === 'textSelect' || tool === 'textselect') {
      const pageCoord = _viewport.worldToPage(ptWorld[0], ptWorld[1]);
      const now = Date.now();
      const cachedData = state.pageTextData && state.pageTextData[pageCoord.sheet];

      const performHit = (data) => {
        if (!data) return;
        const hit = textSelection.findCharAndOffsetAtPageCoord(pageCoord.sheet, pageCoord.px, pageCoord.py);
        if (hit) {
          const prevAnchor = state.textSelectAnchor;
          const isDouble = prevAnchor && (now - prevAnchor.time < 300) && (prevAnchor.sheet === pageCoord.sheet);
          const isTriple = prevAnchor && (now - prevAnchor.time < 600) && prevAnchor.clickCount === 2;
          if (isTriple) {
            state.textSelection = textSelection.expandSelectionToLine(pageCoord.sheet, hit.charIndex);
            state.textSelectAnchor = { sheet: pageCoord.sheet, charIndex: hit.charIndex, time: now, clickCount: 0 };
            state.isSelectingText = false;
          } else if (isDouble) {
            state.textSelection = textSelection.expandSelectionToWord(pageCoord.sheet, hit.charIndex);
            state.textSelectAnchor = { sheet: pageCoord.sheet, charIndex: hit.charIndex, time: now, clickCount: 2 };
            state.isSelectingText = false;
          } else {
            textSelection.clearTextSelection();
            state.isSelectingText = true;
            state.textSelectAnchor = { sheet: pageCoord.sheet, charIndex: hit.charIndex, time: now, clickCount: 1 };
            state.textSelection = textSelection.computeTextSelectionRanges(pageCoord.sheet, hit.charIndex, hit.charIndex);
          }
          if (state.textSelection) state.selectedTextString = state.textSelection.text;
          compositor.redrawAll();
          updateTextSelectionPopover();
        }
      };

      if (cachedData) {
        performHit(cachedData);
      } else {
        state.textSelectPending = { sheet: pageCoord.sheet, px: pageCoord.px, py: pageCoord.py, now, isDown: true };
        textSelection.ensurePageTextData(pageCoord.sheet).then(data => {
          if (state.textSelectPending && state.textSelectPending.isDown) {
            performHit(data);
          }
          state.textSelectPending = null;
        });
      }
    }
  });

  const moveEvt = ('onpointerrawupdate' in window) ? 'pointerrawupdate' : 'pointermove';
  wetCanvas.addEventListener(moveEvt, e => {
    const tool = state.activeTool || 'pen';
    const coalesced = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
    const events = (coalesced && coalesced.length) ? coalesced : [e];

    for (let i = 0; i < events.length; i++) {
      const subEvt = events[i];
      const { ptWorld, pane, screenPt } = localXY(subEvt);

      if (tool === 'pan') {
        if (_panState.isDown && _viewport) {
          const dx = subEvt.clientX - _panState.startClientX;
          const dy = subEvt.clientY - _panState.startClientY;
          _viewport.setPan(_panState.startPanX + dx, _panState.startPanY + dy, _panState.pane);
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            state.spaceDidPan = true;
          }
        }
      } else if (tool === 'pen' || tool === 'highlighter') {
        if (subEvt.buttons === 0) {
          if (state.cur) {
            penTool.onPenUp(subEvt, _viewport);
          }
          continue;
        }
        penTool.onPenMove(subEvt, ptWorld, pane, _viewport);
      } else if (tool === 'eraser') {
        eraserTool.onEraserMove(subEvt, ptWorld, pane, _viewport);
      } else if (tool === 'lasso') {
        if (state.transformMode || state.lassoPath) {
          lassoTool.onLassoMove(subEvt, ptWorld, screenPt, pane, _viewport);
        } else {
          const handle = overlays.getSelectionHandleAt(screenPt[0], screenPt[1], state, _viewport, pane);
          wetCanvas.style.cursor = handle ? handle.cursor : 'crosshair';
        }
      } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler') {
        shapesTool.onShapeMove(subEvt, ptWorld, pane, _viewport);
      } else if (tool === 'laser') {
        laserTool.onLaserMove(subEvt, ptWorld, pane, _viewport);
      } else if (tool === 'textSelect' || tool === 'textselect') {
        if (state.isSelectingText && state.textSelectAnchor) {
          const pageCoord = _viewport.worldToPage(ptWorld[0], ptWorld[1]);
          const anchor = state.textSelectAnchor;
          const hit = textSelection.findCharAndOffsetAtPageCoord(anchor.sheet, pageCoord.px, pageCoord.py);
          if (hit) {
            state.textSelection = textSelection.computeTextSelectionRanges(anchor.sheet, anchor.charIndex, hit.charIndex);
            if (state.textSelection) state.selectedTextString = state.textSelection.text;
            compositor.redrawAll();
          }
        } else if (state.textSelectPending && state.textSelectPending.isDown) {
          const pageCoord = _viewport.worldToPage(ptWorld[0], ptWorld[1]);
          state.textSelectPending.px = pageCoord.px;
          state.textSelectPending.py = pageCoord.py;
        }
      }
    }
  });

  wetCanvas.addEventListener('pointerup', e => {
    const tool = state.activeTool || 'pen';

    if (tool === 'pan') {
      _panState.isDown = false;
    } else if (tool === 'pen' || tool === 'highlighter') {
      penTool.onPenUp(e, _viewport);
    } else if (tool === 'eraser') {
      eraserTool.onEraserUp();
    } else if (tool === 'lasso') {
      lassoTool.onLassoUp(e, _viewport);
    } else if (tool === 'rect' || tool === 'ellipse' || tool === 'ruler') {
      shapesTool.onShapeUp(e, _viewport);
    } else if (tool === 'laser') {
      laserTool.onLaserUp();
    } else if (tool === 'textSelect' || tool === 'textselect') {
      if (state.textSelectPending) {
        state.textSelectPending.isDown = false;
      }
      state.isSelectingText = false;
      if (state.textSelection && state.textSelection.text && state.textSelection.text.trim()) {
        state.selectedTextString = state.textSelection.text;
      }
      compositor.redrawAll();
      updateTextSelectionPopover();
    }
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  wetCanvas.addEventListener('pointercancel', e => {
    _panState.isDown = false;
    penTool.onPenCancel();
    eraserTool.onEraserUp();
    lassoTool.onLassoUp(e, _viewport);
    laserTool.clearLaser();
    try { wetCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  window.addEventListener('pointerup', e => {
    if (state.cur) {
      penTool.onPenUp(e, _viewport);
    }
    if (_panState.isDown) {
      _panState.isDown = false;
    }
  });

  window.addEventListener('pointercancel', () => {
    if (state.cur) {
      penTool.onPenCancel();
    }
    _panState.isDown = false;
  });
}

function getFocusableElements(container) {
  if (!container) return [];
  const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(selector)).filter(el => {
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}

function initModalFocusTrap() {
  const modalIds = [
    'exportModal',
    'settingsModal',
    'shortcutsModal',
    'goToPageModal',
    'insertPageModal',
    'confirmCloseModal',
  ];

  modalIds.forEach(id => {
    const modal = $(id);
    if (!modal) return;

    // Backdrop click listener closes dialog
    modal.addEventListener('click', e => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });

    // Tab key trapping within modal container
    modal.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const focusables = getFocusableElements(modal);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || !modal.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !modal.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    // Set initial focus when modal opens
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'class') {
            if (!modal.classList.contains('hidden')) {
              setTimeout(() => {
                if (!modal.classList.contains('hidden') && !modal.contains(document.activeElement)) {
                  const auto = modal.querySelector('[autofocus]');
                  if (auto && typeof auto.focus === 'function') {
                    auto.focus();
                  } else {
                    const focusables = getFocusableElements(modal);
                    if (focusables.length > 0) focusables[0].focus();
                  }
                }
              }, 10);
            }
          }
        }
      });
      observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    }
  });
}

function attachKeyboardShortcuts() {
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const openModals = [
        'exportModal',
        'settingsModal',
        'shortcutsModal',
        'goToPageModal',
        'insertPageModal',
        'confirmCloseModal',
      ];
      for (const id of openModals) {
        const el = $(id);
        if (el && !el.classList.contains('hidden')) {
          el.classList.add('hidden');
          e.preventDefault();
          return;
        }
      }
      const propPop = $('propPopover');
      if (propPop && !propPop.classList.contains('hidden')) {
        toolbar.hidePropPopover();
        e.preventDefault();
        return;
      }

      if (state.selectedStrokes?.length || state.selectedImages?.length || state.selectedTextObjects?.length) {
        state.selectedStrokes = [];
        state.selectedImages = [];
        state.selectedTextObjects = [];
        state.transformMode = null;
        state.lassoPath = null;
        emit('selectionCleared', {});
        compositor.clearWet();
        compositor.redrawAll();
        e.preventDefault();
        return;
      }
    }

    const isTyping = document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.isContentEditable
    );
    if (isTyping) return;

    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      toolbar.openSettingsModal();
      return;
    }

    if (e.key === '?' || e.key === 'F1') {
      e.preventDefault();
      $('shortcutsModal') && $('shortcutsModal').classList.remove('hidden');
      return;
    }

    if (e.key === ' ' || e.code === 'Space') {
      toolManager.handleSpaceKeyDown(e);
      return;
    }

    // Spring-loaded modifier keys (e.g. holding 'e')
    toolManager.handleSpringKeyDown(e.key);

    const cmd = commandsModule.commands.findMatchingShortcut(e);
    if (cmd) {
      e.preventDefault();
      commandsModule.commands.execute(cmd.id);
    }
  });

  window.addEventListener('keyup', e => {
    if (e.key === ' ' || e.code === 'Space') {
      toolManager.handleSpaceKeyUp(e);
      return;
    }
    toolManager.handleSpringKeyUp(e.key);
  });

  window.addEventListener('blur', () => {
    toolManager.cancelSpringKeys();
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
  toolManager.initStylusIntegration();

  window.addEventListener('resize', () => compositor.resize());
  window.addEventListener('scroll', () => compositor.updateStageRect(), { passive: true });

  // Passive state listeners
  on('toast', payload => toast.showToast(payload.message, payload.type));
  on('toolChanged', payload => {
    toolbar.updateToolbarUI();
    if (payload && (payload.tool === 'textSelect' || payload.tool === 'textselect' || payload.tool === 'highlighter')) {
      textSelection.preloadNearbyPageText(state.leftSheet, _viewport);
    }
    if (payload && payload.tool !== 'lasso') {
      state.lassoPath = null;
      compositor.clearWet();
      compositor.redrawAll();
    }
  });
  on('historyChanged', () => toolbar.updateUndoRedoUI());
  on('pageChanged', payload => {
    const pageDisplay = $('pageNumDisplay');
    if (pageDisplay) {
      pageDisplay.textContent = `Page ${payload.pageIndex + 1} / ${payload.totalPages || 1}`;
    }
    scrollbar.updateDocScrollbar(_viewport);
  });
  on('zoomChanged', payload => {
    const el = $('zoomLevelDisplay');
    if (el && payload && typeof payload.zoom === 'number') {
      el.textContent = Math.round(payload.zoom * 100) + '%';
    }
  });
  on('selectionChanged', updateTextSelectionPopover);
  on('documentChanged', evt => {
    toolbar.updateSaveStatusUI('dirty');
    if (state.autosaveDelayMs > 0 && state.currentDocPath && !state.isSaving) {
      if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
      state.autosaveTimer = setTimeout(() => {
        if (state.isDirty && !state.isSaving) {
          commandsModule.commands.execute('file.save');
        }
      }, state.autosaveDelayMs);
    }

    if (!evt) return;
    const type = evt.type;
    const data = evt.payload || {};

    if (type === 'undo_add_stroke') {
      if (data.stroke && data.stroke.id) {
        ipc.deleteStroke(data.stroke.id).catch(err => {
          console.warn('[inkwell/main] undo_add_stroke deleteStroke error:', err);
        });
      }
    } else if (type === 'undo_erase_strokes') {
      if (Array.isArray(data.strokes)) {
        for (const s of data.strokes) {
          if (s) {
            ipc.commitStroke(s.sheet, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id).catch(err => {
              console.warn('[inkwell/main] undo_erase_strokes commitStroke error:', err);
            });
          }
        }
      }
    } else if (type === 'redo_add_stroke') {
      if (data.stroke) {
        const s = data.stroke;
        ipc.commitStroke(s.sheet, s.kind || s.tool || 'pen', s.rgb, s.base_width || s.baseWidth || 1.6, s.points, s.id).catch(err => {
          console.warn('[inkwell/main] redo_add_stroke commitStroke error:', err);
        });
      }
    } else if (type === 'redo_erase_strokes') {
      if (Array.isArray(data.strokes)) {
        for (const s of data.strokes) {
          if (s && s.id) {
            ipc.deleteStroke(s.id).catch(err => {
              console.warn('[inkwell/main] redo_erase_strokes deleteStroke error:', err);
            });
          }
        }
      }
    }
  });

  // Quit with unsaved changes Tauri event listener
  if (typeof window !== 'undefined' && window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('app-save-and-close', async () => {
      try {
        await commandsModule.commands.execute('file.save');
        if (window.forceCloseWindow) await window.forceCloseWindow();
        else window.close();
      } catch (e) {
        const msg = friendlyError(e);
        if (msg) toast.showToast('Could not save on exit: ' + msg, 'error');
      }
    });
  }

  // Global compatibility bridges
  window.state = state;
  window.toolManager = toolManager;
  window.documentOps = documentOps;
  window.compositor = compositor;
  window.overlays = overlays;
  window.lassoTool = lassoTool;
  window.toolbar = toolbar;
  window.getViewport = getViewport;
  window.undo = () => commandsModule.commands.execute('edit.undo');
  window.redo = () => commandsModule.commands.execute('edit.redo');
  window.showToast = toast.showToast;
  window.forceCloseWindow = () => ipc.invokeTauri('force_close_window');
  window.scheduleRedrawTiles = compositor.scheduleRedrawTiles;
  window.scheduleRedrawAll = compositor.scheduleRedrawAll;
  window.redrawAll = compositor.redrawAll;
  window.emitZoomChanged = (vp) => {
    if (!vp) return;
    const z = vp.splitMode && vp.activePane === 'right' ? vp.rightZoom : vp.zoom;
    emit('zoomChanged', { zoom: z });
  };

  window.addEventListener('pointerdown', e => {
    const ctxM = $('canvasContextMenu');
    if (ctxM && !ctxM.contains(e.target) && !ctxM.classList.contains('hidden')) {
      contextMenu.hideContextMenu();
    }
    const propPop = $('propPopover');
    const dockBtn = $('btnDockAddPreset');
    if (propPop && !propPop.classList.contains('hidden')) {
      if (!propPop.contains(e.target) && (!dockBtn || !dockBtn.contains(e.target))) {
        toolbar.hidePropPopover();
      }
    }
  }, true);

  // Check for initial file passed via CLI argument
  (async () => {
    try {
      const initFile = await ipc.invokeTauri('get_initial_file');
      if (initFile) {
        console.log('[inkwell] Opening initial file from CLI:', initFile);
        const r = await ipc.openPdf(initFile);
        const title = initFile.split('\\').pop().split('/').pop();
        handlePdfLoadResult(title, initFile, r);
        return;
      }
    } catch (e) {
      console.warn('[inkwell] Failed to check initial file:', e);
    }
    // Auto-initialize a blank note on startup if no document is loaded
    if (!state.currentDocPath && (!state.pageInfos || state.pageInfos.length === 0)) {
      createNewWhiteboard();
    }
  })();
});
