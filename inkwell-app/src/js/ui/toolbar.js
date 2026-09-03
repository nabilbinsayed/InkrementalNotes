/* ============================================================================
 * ui/toolbar.js — Complete Toolbar & UI Controls Binding for Inkwell
 * Binds floating dock, tool switches, color pickers, width sliders, modals & zoom.
 * ========================================================================== */

import { state, $, emit } from '../core/state.js';
import * as toolManager from '../tools/tool-manager.js';
import * as commandsModule from '../core/commands.js';
import * as history from '../core/history.js';

let _viewport = null;

export function setViewport(vp) {
  _viewport = vp;
}

export function initToolbar(viewport) {
  if (viewport) _viewport = viewport;
  bindDockButtons();
  bindPropertyControls();
  bindUndoRedoButtons();
  bindZoomControls();
  bindModals();
  updateToolbarUI();
  updateUndoRedoUI();
}

export function updateToolbarUI() {
  const activeTool = state.activeTool || 'pen';

  // Update floating dock button states
  const toolButtonMap = {
    pen: $('btnDockPen'),
    highlighter: $('btnDockHighlighter'),
    eraser: $('btnDockEraser'),
    lasso: $('btnDockLasso'),
    pan: $('btnDockPan'),
    laser: $('btnDockLaser'),
    rect: $('btnDockShapes'),
    ellipse: $('btnDockShapes'),
    ruler: $('btnDockShapes'),
    text: $('btnDockText'),
    textSelect: $('btnDockTextSelect'),
    textselect: $('btnDockTextSelect'),
  };

  document.querySelectorAll('.dock-btn').forEach(btn => {
    if (btn.id !== 'btnDockAddPreset' && btn.id !== 'btnDockStylusOptions') {
      btn.classList.remove('active');
    }
  });

  const activeBtn = toolButtonMap[activeTool];
  if (activeBtn) activeBtn.classList.add('active');

  // Update legacy buttons if present
  const legacyMap = {
    pen: $('btnPen'),
    highlighter: $('btnHighlighter'),
    eraser: $('btnEraser'),
    lasso: $('btnLasso'),
    pan: $('btnPan'),
    laser: $('btnLaser'),
    rect: $('btnRect'),
    ellipse: $('btnEllipse'),
    ruler: $('btnRuler'),
  };
  Object.entries(legacyMap).forEach(([tool, btn]) => {
    if (btn) btn.classList.toggle('active', tool === activeTool);
  });

  updateSaveStatusUI(state.isSaving ? 'saving' : (state.isDirty ? 'dirty' : 'saved'));
}

export function updateSaveStatusUI(status) {
  const badge = $('docStatusBadge');
  const text = $('docStatusText');
  if (!badge || !text) return;

  badge.classList.remove('dirty', 'saving');
  if (status === 'saving') {
    badge.classList.add('saving');
    text.textContent = 'Saving...';
  } else if (status === 'dirty') {
    badge.classList.add('dirty');
    text.textContent = state.autosaveDelayMs > 0 ? 'Autosaving...' : 'Unsaved';
  } else {
    text.textContent = 'Vector Ready';
  }
}

export function updateUndoRedoUI() {
  const btnUndo = $('btnUndo');
  const btnHeaderUndo = $('btnHeaderUndo');
  const btnRedo = $('btnRedo');
  const btnHeaderRedo = $('btnHeaderRedo');

  const canU = history.canUndo();
  const canR = history.canRedo();

  if (btnUndo) {
    btnUndo.disabled = !canU;
    btnUndo.classList.toggle('disabled', !canU);
  }
  if (btnHeaderUndo) {
    btnHeaderUndo.disabled = !canU;
    btnHeaderUndo.classList.toggle('disabled', !canU);
  }
  if (btnRedo) {
    btnRedo.disabled = !canR;
    btnRedo.classList.toggle('disabled', !canR);
  }
  if (btnHeaderRedo) {
    btnHeaderRedo.disabled = !canR;
    btnHeaderRedo.classList.toggle('disabled', !canR);
  }
}

function bindDockButtons() {
  // Dock Tool Buttons
  $('btnDockPan') && $('btnDockPan').addEventListener('click', () => {
    toolManager.setTool('pan');
    updateToolbarUI();
  });

  $('btnDockLasso') && $('btnDockLasso').addEventListener('click', () => {
    toolManager.setTool('lasso');
    updateToolbarUI();
  });

  $('btnDockPen') && $('btnDockPen').addEventListener('click', () => {
    if (state.activeTool === 'pen') {
      togglePropPopover();
    } else {
      toolManager.setTool('pen');
      updateToolbarUI();
    }
  });

  $('btnDockHighlighter') && $('btnDockHighlighter').addEventListener('click', () => {
    if (state.activeTool === 'highlighter') {
      togglePropPopover();
    } else {
      toolManager.setTool('highlighter');
      updateToolbarUI();
    }
  });

  $('btnDockEraser') && $('btnDockEraser').addEventListener('click', () => {
    if (state.activeTool === 'eraser') {
      togglePropPopover();
    } else {
      toolManager.setTool('eraser');
      updateToolbarUI();
    }
  });

  $('btnDockLaser') && $('btnDockLaser').addEventListener('click', () => {
    toolManager.setTool('laser');
    updateToolbarUI();
  });

  $('btnDockShapes') && $('btnDockShapes').addEventListener('click', () => {
    if (state.activeTool === 'rect') {
      toolManager.setTool('ellipse');
      emit('toast', { message: 'Shape: Ellipse', type: 'info' });
    } else if (state.activeTool === 'ellipse') {
      toolManager.setTool('ruler');
      emit('toast', { message: 'Shape: Ruler Line', type: 'info' });
    } else {
      toolManager.setTool('rect');
      emit('toast', { message: 'Shape: Rectangle', type: 'info' });
    }
    updateToolbarUI();
  });

  $('btnDockText') && $('btnDockText').addEventListener('click', () => {
    toolManager.setTool('text');
    emit('toast', { message: 'Sticky Note: Click canvas to annotate', type: 'info' });
    updateToolbarUI();
  });

  $('btnDockTextSelect') && $('btnDockTextSelect').addEventListener('click', () => {
    toolManager.setTool('textSelect');
    updateToolbarUI();
  });

  $('btnDockAddPreset') && $('btnDockAddPreset').addEventListener('click', () => togglePropPopover());
  $('btnDockStylusOptions') && $('btnDockStylusOptions').addEventListener('click', () => openSettingsModal());

  // Legacy buttons if present
  $('btnPen') && $('btnPen').addEventListener('click', () => { toolManager.setTool('pen'); updateToolbarUI(); });
  $('btnHighlighter') && $('btnHighlighter').addEventListener('click', () => { toolManager.setTool('highlighter'); updateToolbarUI(); });
  $('btnEraser') && $('btnEraser').addEventListener('click', () => { toolManager.setTool('eraser'); updateToolbarUI(); });
  $('btnPan') && $('btnPan').addEventListener('click', () => { toolManager.setTool('pan'); updateToolbarUI(); });
  $('btnLasso') && $('btnLasso').addEventListener('click', () => { toolManager.setTool('lasso'); updateToolbarUI(); });
  $('btnLaser') && $('btnLaser').addEventListener('click', () => { toolManager.setTool('laser'); updateToolbarUI(); });
  $('btnRect') && $('btnRect').addEventListener('click', () => { toolManager.setTool('rect'); updateToolbarUI(); });
  $('btnEllipse') && $('btnEllipse').addEventListener('click', () => { toolManager.setTool('ellipse'); updateToolbarUI(); });
  $('btnRuler') && $('btnRuler').addEventListener('click', () => { toolManager.setTool('ruler'); updateToolbarUI(); });
}

export function togglePropPopover() {
  const pop = $('propPopover');
  if (pop) pop.classList.toggle('hidden');
}

export function hidePropPopover() {
  const pop = $('propPopover');
  if (pop && !pop.classList.contains('hidden')) {
    pop.classList.add('hidden');
  }
}

function bindPropertyControls() {
  // Preset color swatches
  document.querySelectorAll('.dock-preset-chip, .swatch, .settings-color-swatch').forEach(chip => {
    chip.addEventListener('click', () => {
      const colorStr = chip.getAttribute('data-color');
      if (colorStr) {
        const rgb = hexToRgb(colorStr);
        if (rgb) toolManager.setColor(rgb);
        document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
        chip.classList.add('active');
      }
    });
  });

  // Color inputs
  $('colorPicker') && $('colorPicker').addEventListener('input', e => {
    const rgb = hexToRgb(e.target.value);
    if (rgb) toolManager.setColor(rgb);
  });

  $('popoverCustomColorPicker') && $('popoverCustomColorPicker').addEventListener('input', e => {
    const rgb = hexToRgb(e.target.value);
    if (rgb) toolManager.setColor(rgb);
  });

  // Stroke width sliders
  const sliders = [$('propWidthSlider'), $('widthSlider'), $('popoverWidthSlider')];
  sliders.forEach(slider => {
    if (slider) {
      slider.addEventListener('input', e => {
        const w = parseFloat(e.target.value);
        if (!isNaN(w)) {
          toolManager.setWidth(w);
          if ($('widthVal')) $('widthVal').textContent = w + ' pt';
          if ($('popoverWidthVal')) $('popoverWidthVal').textContent = w + ' pt';
        }
      });
    }
  });

  // Width presets
  document.querySelectorAll('.btn-width-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = parseFloat(btn.getAttribute('data-width'));
      if (!isNaN(w)) {
        toolManager.setWidth(w);
        if ($('popoverWidthSlider')) $('popoverWidthSlider').value = String(w);
        if ($('popoverWidthVal')) $('popoverWidthVal').textContent = w + ' pt';
        document.querySelectorAll('.btn-width-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });

  $('btnClosePropPopover') && $('btnClosePropPopover').addEventListener('click', () => {
    hidePropPopover();
  });
}

function bindUndoRedoButtons() {
  $('btnUndo') && $('btnUndo').addEventListener('click', () => commandsModule.commands.execute('edit.undo'));
  $('btnHeaderUndo') && $('btnHeaderUndo').addEventListener('click', () => commandsModule.commands.execute('edit.undo'));
  $('btnRedo') && $('btnRedo').addEventListener('click', () => commandsModule.commands.execute('edit.redo'));
  $('btnHeaderRedo') && $('btnHeaderRedo').addEventListener('click', () => commandsModule.commands.execute('edit.redo'));

  history.setUndoRedoUiCallback(() => updateUndoRedoUI());
}

function bindZoomControls() {
  $('btnZoomIn') && $('btnZoomIn').addEventListener('click', () => {
    if (_viewport) {
      _viewport.zoomIn([_viewport.stageW / 2, _viewport.stageH / 2], 'left');
      emit('zoomChanged', { zoom: _viewport.zoom });
    }
  });

  $('btnZoomOut') && $('btnZoomOut').addEventListener('click', () => {
    if (_viewport) {
      _viewport.zoomOut([_viewport.stageW / 2, _viewport.stageH / 2], 'left');
      emit('zoomChanged', { zoom: _viewport.zoom });
    }
  });

  $('btnZoomFit') && $('btnZoomFit').addEventListener('click', () => {
    if (_viewport && state.pageInfos && state.pageInfos[0]) {
      _viewport.fitPage(state.pageInfos[0].width_pt, state.pageInfos[0].height_pt, 'left');
      emit('zoomChanged', { zoom: _viewport.zoom });
    }
  });

  $('btnFullscreen') && $('btnFullscreen').addEventListener('click', () => toggleFullscreen());

  $('btnZoomMenu') && $('btnZoomMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('zoomMenuPopover');
    if (pop) pop.classList.toggle('hidden');
  });

  document.querySelectorAll('.zoom-menu-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const zoomVal = btn.getAttribute('data-zoom');
      if (zoomVal === 'fit-page') {
        if (_viewport && state.pageInfos && state.pageInfos[0]) {
          _viewport.fitPage(state.pageInfos[0].width_pt, state.pageInfos[0].height_pt, 'left');
        }
      } else if (zoomVal === 'fit-width') {
        if (_viewport && state.pageInfos && state.pageInfos[0]) {
          _viewport.fitWidth(state.pageInfos[0].width_pt, 'left');
        }
      } else {
        const factor = parseFloat(zoomVal);
        if (!isNaN(factor) && _viewport) {
          _viewport.setZoom(factor, [_viewport.stageW / 2, _viewport.stageH / 2], 'left');
        }
      }
      closeZoomMenu();
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#zoomMenuPopover') && !e.target.closest('#btnZoomMenu')) {
      closeZoomMenu();
    }
  });
}

export function closeZoomMenu() {
  const el = $('zoomMenuPopover');
  if (el) el.classList.add('hidden');
}

export function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function bindModals() {
  // Settings modal
  $('btnHeaderSettings') && $('btnHeaderSettings').addEventListener('click', openSettingsModal);
  $('btnCloseSettingsModal') && $('btnCloseSettingsModal').addEventListener('click', closeSettingsModal);
  $('settingsModal') && $('settingsModal').addEventListener('click', e => {
    if (e.target === $('settingsModal')) closeSettingsModal();
  });

  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab) switchSettingsTab(tab);
    });
  });

  // Go to Page modal
  $('btnPageDropdown') && $('btnPageDropdown').addEventListener('click', () => openGoToPageModal());
  $('pageNumDisplay') && $('pageNumDisplay').addEventListener('click', () => openGoToPageModal());
  $('btnCloseGoToPageModal') && $('btnCloseGoToPageModal').addEventListener('click', () => closeGoToPageModal());
  $('btnCancelGoToPage') && $('btnCancelGoToPage').addEventListener('click', () => closeGoToPageModal());

  // Shortcuts modal
  $('btnCloseShortcutsModal') && $('btnCloseShortcutsModal').addEventListener('click', () => {
    $('shortcutsModal') && $('shortcutsModal').classList.add('hidden');
  });

  // Export modal
  $('btnHeaderExport') && $('btnHeaderExport').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.remove('hidden');
  });
  $('btnCloseExportModal') && $('btnCloseExportModal').addEventListener('click', () => {
    $('exportModal') && $('exportModal').classList.add('hidden');
  });

  const btnSave = $('btnExportIncremental');
  if (btnSave) {
    const triggerSave = () => {
      $('exportModal')?.classList.add('hidden');
      commandsModule.commands.execute('file.save');
    };
    btnSave.addEventListener('click', triggerSave);
    btnSave.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerSave();
      }
    });
  }

  const btnExportNew = $('btnExportFlattened');
  if (btnExportNew) {
    const triggerExport = () => {
      $('exportModal')?.classList.add('hidden');
      commandsModule.commands.execute('file.exportPdf');
    };
    btnExportNew.addEventListener('click', triggerExport);
    btnExportNew.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerExport();
      }
    });
  }
}

export function openSettingsModal() {
  $('settingsModal') && $('settingsModal').classList.remove('hidden');
}

export function closeSettingsModal() {
  $('settingsModal') && $('settingsModal').classList.add('hidden');
}

export function switchSettingsTab(tabName) {
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });
  document.querySelectorAll('.settings-tab-panel').forEach(panel => {
    const isMatch = panel.id === tabName || panel.getAttribute('data-panel') === tabName;
    panel.classList.toggle('active', isMatch);
    panel.classList.toggle('hidden', !isMatch);
  });
}

export function openGoToPageModal() {
  $('goToPageModal') && $('goToPageModal').classList.remove('hidden');
  const input = $('goToPageInput');
  if (input) {
    input.value = String((state.leftSheet || 0) + 1);
    input.focus();
  }
}

export function closeGoToPageModal() {
  $('goToPageModal') && $('goToPageModal').classList.add('hidden');
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? [
    parseInt(result[1], 16) / 255,
    parseInt(result[2], 16) / 255,
    parseInt(result[3], 16) / 255
  ] : null;
}
