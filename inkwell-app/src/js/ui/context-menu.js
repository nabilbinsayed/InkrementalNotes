/* ============================================================================
 * ui/context-menu.js — Context Menus for Inkwell Canvas & Selection
 * Provides right-click contextual actions (Cut, Copy, Paste, Duplicate, Delete).
 * ========================================================================== */

import { $ } from '../core/state.js';
import * as commandsModule from '../core/commands.js';

export function showContextMenu(screenX, screenY) {
  const menu = $('canvasContextMenu');
  if (!menu) return;

  const w = 180;
  const h = 200;
  const x = Math.max(10, Math.min(window.innerWidth - w - 10, screenX));
  const y = Math.max(10, Math.min(window.innerHeight - h - 10, screenY));

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove('hidden');
}

export function hideContextMenu() {
  const menu = $('canvasContextMenu');
  if (menu) menu.classList.add('hidden');
}

export function initContextMenu() {
  $('ctxMenuCut') && $('ctxMenuCut').addEventListener('click', () => {
    hideContextMenu();
    commandsModule.commands.execute('edit.cut');
  });

  $('ctxMenuCopy') && $('ctxMenuCopy').addEventListener('click', () => {
    hideContextMenu();
    commandsModule.commands.execute('edit.copy');
  });

  $('ctxMenuPaste') && $('ctxMenuPaste').addEventListener('click', () => {
    hideContextMenu();
    commandsModule.commands.execute('edit.paste');
  });

  $('ctxMenuDuplicate') && $('ctxMenuDuplicate').addEventListener('click', () => {
    hideContextMenu();
    commandsModule.commands.execute('edit.duplicate');
  });

  $('ctxMenuDelete') && $('ctxMenuDelete').addEventListener('click', () => {
    hideContextMenu();
    commandsModule.commands.execute('edit.delete');
  });
}
