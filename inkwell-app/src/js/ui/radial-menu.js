/* ============================================================================
 * ui/radial-menu.js — Floating Stylus Barrel Radial Quick Menu for Inkwell
 * 6-slot circular action dial for instantaneous pen, highlighter, eraser, lasso tool switching.
 * ========================================================================== */

import { state, $ } from '../core/state.js';
import * as toolManager from '../tools/tool-manager.js';
import * as commandsModule from '../core/commands.js';
import * as commandPalette from './command-palette.js';

export function showRadialMenu(screenX, screenY) {
  const menu = $('radialMenu');
  if (!menu) return;

  const menuSize = 180;
  const x = Math.max(10, Math.min(window.innerWidth - menuSize - 10, screenX - menuSize / 2));
  const y = Math.max(10, Math.min(window.innerHeight - menuSize - 10, screenY - menuSize / 2));

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove('hidden');

  updateRadialActiveTool();
}

export function hideRadialMenu() {
  const menu = $('radialMenu');
  if (menu) menu.classList.add('hidden');
}

export function initRadialMenu() {
  const menu = $('radialMenu');
  if (!menu) return;

  menu.querySelectorAll('.radial-item').forEach(item => {
    item.addEventListener('click', e => {
      e.stopPropagation();
      const tool = item.getAttribute('data-tool');
      const action = item.getAttribute('data-action');
      if (tool) {
        toolManager.setTool(tool);
        hideRadialMenu();
      } else if (action === 'undo') {
        hideRadialMenu();
        commandsModule.commands.execute('edit.undo');
      } else if (action === 'palette') {
        hideRadialMenu();
        commandPalette.openCommandPalette();
      } else {
        hideRadialMenu();
      }
    });
  });

  window.addEventListener('pointerdown', e => {
    if (menu && !menu.contains(e.target) && !menu.classList.contains('hidden')) {
      hideRadialMenu();
    }
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu && !menu.classList.contains('hidden')) {
      hideRadialMenu();
    }
  });
}

function updateRadialActiveTool() {
  const menu = $('radialMenu');
  if (!menu) return;
  const current = state.activeTool || 'pen';
  menu.querySelectorAll('.radial-item').forEach(item => {
    item.classList.toggle('active', item.getAttribute('data-tool') === current);
  });
}
