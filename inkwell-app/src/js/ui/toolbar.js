/* ============================================================================
 * ui/toolbar.js — Complete Toolbar & UI Controls Binding for Inkwell
 * Binds floating dock, tool switches, color pickers, width sliders, modals & zoom.
 * ========================================================================== */

import { state, $, emit, on } from '../core/state.js';
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
  on('toolPropertyChanged', () => syncColorUI());
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
    line: $('btnDockShapes'),
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
    line: $('btnRuler'),
  };
  Object.entries(legacyMap).forEach(([tool, btn]) => {
    if (btn) btn.classList.toggle('active', tool === activeTool);
  });

  const shapesBtn = $('btnDockShapes');
  if (shapesBtn) {
    const iconSvg = shapesBtn.querySelector('.dock-icon');
    const shortcutSpan = shapesBtn.querySelector('.dock-shortcut');
    if (activeTool === 'ellipse' || state.shapeKind === 'ellipse') {
      if (iconSvg) iconSvg.innerHTML = '<circle cx="12" cy="12" r="8"/>';
      shapesBtn.title = 'Shape: Ellipse (O)';
      if (shortcutSpan) shortcutSpan.textContent = 'O';
    } else if (activeTool === 'line' || activeTool === 'ruler' || state.shapeKind === 'line') {
      if (iconSvg) iconSvg.innerHTML = '<line x1="4" y1="20" x2="20" y2="4"/><line x1="8" y1="14" x2="10" y2="16"/><line x1="11" y1="11" x2="13" y2="13"/><line x1="14" y1="8" x2="16" y2="10"/>';
      shapesBtn.title = 'Shape: Line (L)';
      if (shortcutSpan) shortcutSpan.textContent = 'L';
    } else {
      if (iconSvg) iconSvg.innerHTML = '<rect x="4" y="4" width="16" height="16" rx="2"/>';
      shapesBtn.title = 'Shape: Rectangle (R)';
      if (shortcutSpan) shortcutSpan.textContent = 'R';
    }
  }

  syncColorUI();
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
      emit('toast', { message: 'Shape: Ellipse (O)', type: 'info' });
    } else if (state.activeTool === 'ellipse') {
      toolManager.setTool('line');
      emit('toast', { message: 'Shape: Line (L)', type: 'info' });
    } else {
      toolManager.setTool('rect');
      emit('toast', { message: 'Shape: Rectangle (R)', type: 'info' });
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
  if (pop) {
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) {
      syncColorUI();
    }
  }
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
      const pi = state.pageInfos[0];
      const r = _viewport.stageRect || { width: 800, height: 600 };
      const availW = Math.max(100, r.width - 48);
      const availH = Math.max(100, r.height - 48);
      const pageW = pi.width_pt || 595.0;
      const pageH = pi.height_pt || 842.0;
      const pageZoom = Math.min(availW / pageW, availH / pageH);
      const widthZoom = availW / pageW;

      // Toggle to fitWidth if already in fitPage, allowing widescreen displays to fill the page
      if (Math.abs(_viewport.zoom - pageZoom) < 0.05 && widthZoom > pageZoom * 1.1) {
        _viewport.fitWidth(pageW, 'left');
      } else {
        _viewport.fitPage(pageW, pageH, 'left');
      }
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

export function rgbToHex(rgb) {
  if (!rgb || !Array.isArray(rgb) || rgb.length < 3) return '#141724';
  return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v * 255))).toString(16).padStart(2, '0')).join('');
}

export function drawStrokePreview() {
  const canvas = $('strokePreviewCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width;
  const h = canvas.height;
  const midY = h / 2;
  const isHighlighter = state.activeTool === 'highlighter';
  const baseW = state.baseWidth || (isHighlighter ? 16.0 : 1.6);
  const rgb = state.color || [0.08, 0.09, 0.14];
  const colorStr = `rgb(${rgb.map(v => Math.round(v * 255)).join(',')})`;

  ctx.save();
  if (isHighlighter) {
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = Math.min(h - 6, baseW);
    ctx.lineCap = 'square';
  } else {
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = Math.min(h - 4, baseW);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  ctx.beginPath();
  ctx.moveTo(20, midY);
  ctx.bezierCurveTo(w * 0.35, midY - 7, w * 0.65, midY + 7, w - 20, midY);
  ctx.stroke();
  ctx.restore();
}

export function syncColorUI(rgb) {
  const color = rgb || state.color || [0.08, 0.09, 0.14];
  const hex = rgbToHex(color);

  // 1. Sync custom color picker inputs
  const customPicker = $('popoverCustomColorPicker');
  if (customPicker && customPicker.value.toLowerCase() !== hex.toLowerCase()) {
    customPicker.value = hex;
  }
  const colorPicker = $('colorPicker');
  if (colorPicker && colorPicker.value.toLowerCase() !== hex.toLowerCase()) {
    colorPicker.value = hex;
  }

  // 2. Sync curated and custom color swatches
  document.querySelectorAll('.color-swatches-grid .swatch, .dock-preset-chip, .settings-color-swatch').forEach(s => {
    const sColor = s.getAttribute('data-color');
    const isMatch = sColor && sColor.toLowerCase() === hex.toLowerCase();
    s.classList.toggle('active', !!isMatch);
  });

  // 3. Sync width sliders & labels
  const activeWidth = state.baseWidth || 1.6;
  const popSlider = $('popoverWidthSlider');
  if (popSlider) popSlider.value = String(activeWidth);
  const propSlider = $('propWidthSlider');
  if (propSlider) propSlider.value = String(activeWidth);
  const mainSlider = $('widthSlider');
  if (mainSlider) mainSlider.value = String(activeWidth);

  const popWidthVal = $('popoverWidthVal');
  if (popWidthVal) popWidthVal.textContent = activeWidth + ' pt';
  const widthVal = $('widthVal');
  if (widthVal) widthVal.textContent = activeWidth + ' pt';

  document.querySelectorAll('.btn-width-preset').forEach(b => {
    const pw = parseFloat(b.getAttribute('data-width'));
    b.classList.toggle('active', Math.abs(pw - activeWidth) < 0.1);
  });

  // 4. Update popover title according to active tool
  const toolTitle = $('popoverToolTitle');
  if (toolTitle) {
    const toolTitles = {
      pen: 'Pen Properties',
      highlighter: 'Highlighter Properties',
      rect: 'Rectangle Properties',
      ellipse: 'Ellipse Properties',
      ruler: 'Line Properties',
      line: 'Line Properties',
      text: 'Text Note Properties',
      laser: 'Laser Properties',
      eraser: 'Eraser Properties',
      lasso: 'Lasso Properties',
    };
    toolTitle.textContent = toolTitles[state.activeTool] || 'Tool Properties';
  }

  // 5. Draw live stroke preview
  drawStrokePreview();
}

