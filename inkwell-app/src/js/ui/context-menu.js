/* ============================================================================
 * ui/context-menu.js — Context Menus for Inkwell Canvas & Selection
 * Provides right-click contextual actions (Cut, Copy, Paste, Duplicate, Delete).
 * ========================================================================== */

import { $ } from '../core/state.js';
import * as commandsModule from '../core/commands.js';

let _lastContextMenuTarget = null;

export function getLastContextMenuTarget() {
  return _lastContextMenuTarget;
}

export function clearLastContextMenuTarget() {
  _lastContextMenuTarget = null;
}

export function showContextMenu(screenX, screenY, contextInfo = {}) {
  const menu = $('canvasContextMenu');
  if (!menu) return;

  _lastContextMenuTarget = {
    screenX,
    screenY,
    ...contextInfo,
  };

  const w = 190;
  const h = 240;
  const x = Math.max(10, Math.min(window.innerWidth - w - 10, screenX));
  const y = Math.max(10, Math.min(window.innerHeight - h - 10, screenY));

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // Dynamically update enabled/disabled states of context menu items
  import('../core/state.js').then(({ state }) => {
    import('../core/clipboard.js').then(clipboard => {
      const hasSelection = (state.selectedStrokes && state.selectedStrokes.length > 0) ||
                           (state.selectedImages && state.selectedImages.length > 0) ||
                           (state.selectedTextObjects && state.selectedTextObjects.length > 0);
      const hasTextSelection = !!(state.selectedTextString && state.selectedTextString.length > 0);
      const canCopy = hasSelection || hasTextSelection;
      const canPaste = clipboard.hasClipboardContent() || true;

      const setItemEnabled = (id, enabled) => {
        const item = $(id);
        if (item) {
          item.classList.toggle('disabled', !enabled);
          item.setAttribute('aria-disabled', String(!enabled));
        }
      };

      setItemEnabled('ctxMenuCut', hasSelection);
      setItemEnabled('ctxMenuCopy', canCopy);
      setItemEnabled('ctxMenuDuplicate', hasSelection);
      setItemEnabled('ctxMenuDelete', hasSelection);
      setItemEnabled('ctxMenuPaste', canPaste);
      setItemEnabled('ctxMenuSelectAll', true);
    });
  });

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

  $('ctxMenuSelectAll') && $('ctxMenuSelectAll').addEventListener('click', () => {
    hideContextMenu();
    commandsModule.commands.execute('edit.selectAll');
  });

  $('ctxMenuDelete') && $('ctxMenuDelete').addEventListener('click', () => {
    hideContextMenu();
    commandsModule.commands.execute('edit.delete');
  });
}
