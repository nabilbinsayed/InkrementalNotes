/* ============================================================================
 * ui/radial-menu.js — Floating Stylus Barrel Radial Quick Menu for Inkwell
 * 6-slot circular action dial for instantaneous pen, highlighter, eraser, lasso tool switching.
 * ========================================================================== */

import { state, $ } from '../core/state.js';
import * as toolManager from '../tools/tool-manager.js';

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

  menu.querySelectorAll('.radial-slot').forEach(slot => {
    slot.addEventListener('click', e => {
      e.stopPropagation();
      const tool = slot.getAttribute('data-tool');
      if (tool) {
        toolManager.setTool(tool);
        hideRadialMenu();
      }
    });
  });
}

function updateRadialActiveTool() {
  const menu = $('radialMenu');
  if (!menu) return;
  const current = state.activeTool || 'pen';
  menu.querySelectorAll('.radial-slot').forEach(slot => {
    slot.classList.toggle('active', slot.getAttribute('data-tool') === current);
  });
}
