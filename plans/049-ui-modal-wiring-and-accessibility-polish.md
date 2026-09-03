# Plan 049: UI Modal Action Wiring, Focus Trapping & Accessibility Polish

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat bd18cc4..HEAD -- inkwell-app/src/index.html inkwell-app/src/js/ui/toolbar.js inkwell-app/src/js/main.js inkwell-app/src/js/tools/text.js inkwell-app/src/js/tools/tool-manager.js`
> Confirm live code matches the excerpts below; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: ui / ux / accessibility
- **Planned at**: commit `bd18cc4`, 2026-09-03

## Why this matters

Multiple core user interface workflows contain dead interactive controls, inaccessible modals, or broken state toggles:
1. In the Export & Save modal, the primary action cards `#btnExportIncremental` ("Save Document") and `#btnExportFlattened` ("Export As New Copy") have zero event listeners attached, making the modal completely unresponsive to clicks.
2. In Preferences, clicking any category ("Autosave & Durability", "Page Defaults", "Engine & View", "Shortcuts & About") fails because `switchSettingsTab` queries `.settings-panel` instead of `.settings-tab-panel` and matches against `data-panel` instead of element IDs.
3. Modals (`#shortcutsModal`, `#settingsModal`, `#exportModal`, `#goToPageModal`, `#insertPageModal`) lack keyboard focus traps, initial focus, backdrop click dismissal, and global Escape dismissal.
4. Inline text annotation editor formatting controls (`#btnTextSizeDec`, `#btnTextSizeInc`, `#btnTextBold`, `#btnTextItalic`, `#btnTextDeleteBox`, `.text-color-swatch`) have no click handlers; furthermore, clicking them steals focus from the textarea, which triggers the blur listener and prematurely commits and closes the editor.
5. Standard keyboard shortcut 'E' (Eraser) is wired to `handleSpringKeyDown` in `tool-manager.js`, which forces the tool back to the pen immediately upon releasing the key (`keyup`), preventing standard tool switching.
6. The Shortcuts modal and `Ctrl+,` command are missing from the command palette and key listeners.

## Current state

- `inkwell-app/src/index.html`:
  - Line 780: `<div class="export-option-card recommended" id="btnExportIncremental" tabindex="0" role="button" aria-label="Save Document">`
  - Line 794: `<div class="export-option-card" id="btnExportFlattened" tabindex="0" role="button" aria-label="Export Flattened Copy">`
  - Lines 427-446: formatting buttons (`btnTextSizeDec`, `btnTextSizeInc`, `btnTextBold`, `btnTextItalic`, `btnTextDeleteBox`, `.text-color-swatch`)
  - Lines 1097-1115 & 1122: `.settings-nav-item` buttons use `data-tab="tabInking"`, panels use `class="settings-tab-panel" id="tabInking"`.
- `inkwell-app/src/js/ui/toolbar.js`:
  - Lines 397-404:
    ```javascript
    export function switchSettingsTab(tabName) {
      document.querySelectorAll('.settings-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
      });
      document.querySelectorAll('.settings-panel').forEach(panel => {
        panel.classList.toggle('hidden', panel.getAttribute('data-panel') !== tabName);
      });
    }
    ```
- `inkwell-app/src/js/main.js`:
  - Lines 739-742:
    ```javascript
    textarea.addEventListener('blur', () => {
      textTool.commitEditing();
    });
    ```
  - Line 1001-1012: `Escape` key listener only handles `#insertPageModal` and `#propPopover`.
- `inkwell-app/src/js/tools/tool-manager.js`:
  - Lines 204-219: `handleSpringKeyDown` and `handleSpringKeyUp` bind key `'e'`/`'E'` as momentary spring hold.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Frontend syntax check | `node --check inkwell-app/src/js/ui/toolbar.js && node --check inkwell-app/src/js/main.js && node --check inkwell-app/src/js/tools/text.js` | exit 0 |
| Rust backend check | `cd inkwell-app/src-tauri && cargo check` | exit 0 |

## Scope

**In scope**:
- `inkwell-app/src/index.html`
- `inkwell-app/src/js/ui/toolbar.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/src/js/tools/text.js`
- `inkwell-app/src/js/tools/tool-manager.js`

**Out of scope**:
- Do not alter backend PDF text embedding or font definitions.
- Do not refactor the CSS design system.

## Steps

### Step 1: Wire Export Modal Action Cards in `toolbar.js`

In `inkwell-app/src/js/ui/toolbar.js::initToolbar()`:
1. Bind `#btnExportIncremental` click and `Enter`/`Space` keydown:
   ```javascript
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
   ```
2. Bind `#btnExportFlattened` click and `Enter`/`Space` keydown:
   ```javascript
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
   ```

**Verify**: `node --check inkwell-app/src/js/ui/toolbar.js` → exit 0.

### Step 2: Fix Preferences Tab Switching in `toolbar.js`

Update `switchSettingsTab(tabName)` in `toolbar.js`:
```javascript
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
```
Attach click listeners to all `.settings-nav-item` buttons during toolbar init:
```javascript
document.querySelectorAll('.settings-nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.getAttribute('data-tab');
    if (tab) switchSettingsTab(tab);
  });
});
```

**Verify**: `node --check inkwell-app/src/js/ui/toolbar.js` → exit 0.

### Step 3: Implement Focus Trapping and Escape Handling for All Modals

In `main.js`:
1. Expand the global `Escape` keydown handler to close all active modal overlays:
   ```javascript
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
   ```
2. For all modal overlays, attach a backdrop click listener that closes the dialog when clicking the outer backdrop (`e.target === modalContainer`).
3. Add a focus-trap helper when a modal opens: focus the first focusable child, and wrap `Tab`/`Shift+Tab` within the modal container.

**Verify**: `node --check inkwell-app/src/js/main.js` → exit 0.

### Step 4: Fix Inline Text Editor Formatting Controls and Blur Dismissal

1. In `main.js`:
   Prevent `pointerdown` / `mousedown` default on `#inlineTextToolbar` elements so clicking styling buttons does not blur `#inlineTextarea`:
   ```javascript
   const tb = $('inlineTextToolbar');
   if (tb) {
     tb.addEventListener('mousedown', (e) => e.preventDefault());
   }
   ```
2. In `text.js`:
   Expose methods to format the active text object:
   - `changeFontSize(delta)`: updates active text object font size, updates `#lblTextSize`, and refreshes textarea style.
   - `toggleBold()`: toggles `bold: !active.bold` and textarea font weight.
   - `toggleItalic()`: toggles `italic: !active.italic` and textarea font style.
   - `setColor(hex)`: updates active text color and textarea text color.
   - `deleteActiveTextBox()`: removes the text object and commits.
3. Wire buttons (`btnTextSizeDec`, `btnTextSizeInc`, `btnTextBold`, `btnTextItalic`, `btnTextDeleteBox`, `.text-color-swatch`) to these methods.

**Verify**: `node --check inkwell-app/src/js/tools/text.js` → exit 0.

### Step 5: Fix Eraser Shortcut 'E' Spring Key Behavior

In `tool-manager.js`:
Differentiate between a tap (standard tool switch) and a long hold (spring-loaded switch):
```javascript
let eDownTime = 0;
export function handleSpringKeyDown(key) {
  if (state.springKey) return;
  if (key === 'e' || key === 'E') {
    state.springKey = 'e';
    eDownTime = performance.now();
    state.prevTool = state.activeTool;
    setTool('eraser', { isUserSwitch: true });
  }
}

export function handleSpringKeyUp(key) {
  if (!state.springKey) return;
  if ((key === 'e' || key === 'E') && state.springKey === 'e') {
    state.springKey = null;
    const duration = performance.now() - eDownTime;
    // Only revert if held for longer than 350ms (momentary hold)
    if (duration > 350) {
      setTool(state.prevTool || 'pen', { isUserSwitch: false });
    }
  }
}
```

**Verify**: `node --check inkwell-app/src/js/tools/tool-manager.js` → exit 0.

### Step 6: Register Shortcuts and Preferences in Commands & Shortcuts

1. In `commands.js`:
   Register:
   - `modal.preferences`: opens `#settingsModal` (shortcut `Ctrl+,`)
   - `modal.shortcuts`: opens `#shortcutsModal` (shortcut `?` and `F1`)
2. In `main.js`:
   Bind `Ctrl+,` and `?`/`F1` in `attachKeyboardShortcuts`.

**Verify**: `node --check inkwell-app/src/js/main.js` → exit 0.

## Test plan

1. Automated checks:
   - Run `node --check` on all touched JS files.
2. Manual verification:
   - Open Export modal: click "Save Document" and verify document saves. Click "Export As New Copy" and verify save dialog appears.
   - Open Preferences: click "Autosave & Durability", "Page Defaults", "Engine & View", "Shortcuts & About" and verify each tab switches cleanly.
   - Press `Escape` while any modal is open and verify it dismisses.
   - Click Bold, Italic, and color swatches on the text tool without editor disappearing.
   - Tap 'E' on keyboard: verify tool switches to Eraser and remains on Eraser after releasing key.

## Done criteria

- [ ] `#btnExportIncremental` and `#btnExportFlattened` trigger document save and export actions.
- [ ] Preferences tabs switch between all panels without getting stuck.
- [ ] Escape key dismisses all open modals.
- [ ] Text styling buttons format active text annotation without losing focus or committing prematurely.
- [ ] Tapping 'E' switches to eraser without snapping back on key release.
- [ ] `Ctrl+,` opens Preferences modal; `?` opens Shortcuts modal.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If text formatting changes alter the PDF export layout of existing text objects, stop and verify `text_embed.rs` coordinate assumptions.
