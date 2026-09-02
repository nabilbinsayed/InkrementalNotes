/* ============================================================================
 * ui/command-palette.js — Searchable Command Palette & Shortcuts Modal for Inkwell
 * Provides quick global command launching with fuzzy search and key navigation.
 * ========================================================================== */

import { $, escapeHtml } from '../core/state.js';
import * as commandsModule from '../core/commands.js';

let _selectedIndex = 0;
let _currentMatches = [];

export function openCommandPalette() {
  const modal = $('cmdPaletteModal');
  const input = $('cmdPaletteInput');
  if (!modal || !input) return;

  modal.classList.remove('hidden');
  input.value = '';
  _selectedIndex = 0;
  filterCommands('');
  input.focus();
}

export function closeCommandPalette() {
  const modal = $('cmdPaletteModal');
  if (modal) modal.classList.add('hidden');
}

export function initCommandPalette() {
  const modal = $('cmdPaletteModal');
  const input = $('cmdPaletteInput');
  const backdrop = $('cmdPaletteBackdrop') || modal;
  if (!modal || !input) return;

  if (backdrop) {
    backdrop.addEventListener('click', e => {
      if (e.target === modal || e.target === backdrop) {
        closeCommandPalette();
      }
    });
  }

  input.addEventListener('input', e => {
    _selectedIndex = 0;
    filterCommands(e.target.value);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (_currentMatches.length > 0) {
        _selectedIndex = (_selectedIndex + 1) % _currentMatches.length;
        updateSelectionHighlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (_currentMatches.length > 0) {
        _selectedIndex = (_selectedIndex - 1 + _currentMatches.length) % _currentMatches.length;
        updateSelectionHighlight();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (_currentMatches.length > 0 && _currentMatches[_selectedIndex]) {
        const cmd = _currentMatches[_selectedIndex];
        closeCommandPalette();
        commandsModule.commands.execute(cmd.id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCommandPalette();
    }
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      closeCommandPalette();
    }
  });
}

function updateSelectionHighlight() {
  const list = $('cmdPaletteResults') || $('cmdPaletteList');
  if (!list) return;
  const items = list.querySelectorAll('.cmd-item');
  items.forEach((item, idx) => {
    const isSelected = idx === _selectedIndex;
    item.classList.toggle('selected', isSelected);
    if (isSelected) {
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

export function filterCommands(query) {
  const list = $('cmdPaletteResults') || $('cmdPaletteList');
  if (!list) return;

  const allCmds = commandsModule.commands.getAll();
  const q = (query || '').toLowerCase().trim();

  _currentMatches = allCmds.filter(cmd => {
    if (!q) return true;
    return cmd.title.toLowerCase().includes(q) || (cmd.category && cmd.category.toLowerCase().includes(q));
  });

  if (!_currentMatches.length) {
    list.innerHTML = `<div class="cmd-empty-state">No matching commands for "${escapeHtml(query)}"</div>`;
    return;
  }

  list.innerHTML = _currentMatches.map((cmd, idx) => {
    const isSelected = idx === _selectedIndex;
    const shortcutHtml = cmd.shortcut ? `<kbd class="cmd-shortcut">${escapeHtml(Array.isArray(cmd.shortcut) ? cmd.shortcut.join(' / ') : cmd.shortcut)}</kbd>` : '';
    return `
      <div class="cmd-item ${isSelected ? 'selected' : ''}" data-index="${idx}">
        <div class="cmd-item-main">
          <span class="cmd-item-title">${escapeHtml(cmd.title)}</span>
          <span class="cmd-item-cat">${escapeHtml(cmd.category)}</span>
        </div>
        ${shortcutHtml}
      </div>
    `;
  }).join('');

  list.querySelectorAll('.cmd-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.getAttribute('data-index'), 10);
      if (!isNaN(idx) && _currentMatches[idx]) {
        closeCommandPalette();
        commandsModule.commands.execute(_currentMatches[idx].id);
      }
    });
  });
}
