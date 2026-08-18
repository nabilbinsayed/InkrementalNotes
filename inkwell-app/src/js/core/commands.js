/* ============================================================================
 * core/commands.js — Central Command Registry & Keybindings Engine for Inkwell
 * Every user-facing action is a named command with stable ID and metadata.
 * ========================================================================== */

class CommandRegistry {
  constructor() {
    this._commands = new Map();
  }

  register(command) {
    if (!command || !command.id) {
      throw new Error('[inkwell/commands] Command must have a valid id');
    }
    this._commands.set(command.id, {
      id: command.id,
      title: command.title || command.id,
      category: command.category || 'General',
      shortcut: command.shortcut || null,
      description: command.description || '',
      icon: command.icon || null,
      execute: command.execute || (() => {}),
      canExecute: command.canExecute || (() => true),
    });
  }

  unregister(id) {
    this._commands.delete(id);
  }

  get(id) {
    return this._commands.get(id) || null;
  }

  getAll() {
    return Array.from(this._commands.values());
  }

  execute(id, ...args) {
    const cmd = this._commands.get(id);
    if (!cmd) {
      console.warn(`[inkwell/commands] Unknown command id: "${id}"`);
      return false;
    }
    if (typeof cmd.canExecute === 'function' && !cmd.canExecute()) {
      return false;
    }
    try {
      cmd.execute(...args);
      return true;
    } catch (err) {
      console.error(`[inkwell/commands] Error executing command "${id}":`, err);
      return false;
    }
  }

  findMatchingShortcut(e) {
    // Normalise keyboard event to standard shortcut string e.g. "Ctrl+S", "Ctrl+Shift+P", "Delete", "P"
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let key = e.key;
    if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') {
      return null;
    }

    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();

    parts.push(key);
    const chord = parts.join('+');

    for (const cmd of this._commands.values()) {
      if (!cmd.shortcut) continue;
      const shortcuts = Array.isArray(cmd.shortcut) ? cmd.shortcut : [cmd.shortcut];
      for (const sc of shortcuts) {
        if (normaliseShortcut(sc) === normaliseShortcut(chord)) {
          return cmd;
        }
      }
    }
    return null;
  }
}

function normaliseShortcut(str) {
  if (!str) return '';
  return str.split('+')
    .map(s => s.trim().toLowerCase())
    .sort()
    .join('+');
}

export const commands = new CommandRegistry();
