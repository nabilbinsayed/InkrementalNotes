# Plan 004: Tauri v2 Dialog Plugin Binding & File Loading Wiring

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 80d21c6..HEAD -- inkwell-app/src/js/app.js inkwell-app/src-tauri/capabilities/default.json`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-pdf-import-pdfium-fallback.md
- **Category**: bug
- **Planned at**: commit `80d21c6`, 2026-08-08

## Why this matters

In Tauri v2, native dialog API calls differ from Tauri v1. Currently `app.js` checks `window.__TAURI_PLUGIN_DIALOG__ || window.__TAURI__.dialog`, which is undefined in default Tauri v2 bundles. Consequently, clicking "Open PDF" always falls back to the HTML file picker `<input type="file">`. The file picker reads the PDF binary into JS and passes the raw bytes over IPC via `open_pdf_bytes`. Passing multi-megabyte PDF byte arrays as JSON numbers causes heavy memory overhead and performance hiccups. Modernizing the Tauri v2 dialog call lets the desktop shell pass native file paths directly to `open_pdf`.

## Current state

File involved:
- `inkwell-app/src/js/app.js` (lines 935–965).
- `inkwell-app/src-tauri/capabilities/default.json` (lines 5–8).

Code excerpt (`app.js:935-945`):
```javascript
  $('btnOpen').addEventListener('click', async () => {
    if (window.__TAURI__) {
      try {
        const dlg = window.__TAURI_PLUGIN_DIALOG__ || (window.__TAURI__ && window.__TAURI__.dialog);
        if (dlg && dlg.open) {
          const selected = await dlg.open({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
```

## Scope

**In scope**:
- `inkwell-app/src/js/app.js`
- `inkwell-app/src-tauri/capabilities/default.json`

**Out of scope**:
- Rust main app initialization (already registers `tauri_plugin_dialog::init()`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Cargo check | `& "$env:USERPROFILE\.cargo\bin\cargo.exe" check --manifest-path inkwell-app/src-tauri/Cargo.toml` | exit 0 |

## Steps

### Step 1: Support standard Tauri v2 dialog invoke format in `app.js`

In `inkwell-app/src/js/app.js`:
Update `btnOpen` click handler to attempt `window.__TAURI__.core.invoke('plugin:dialog|open', ...)` or `window.__TAURI_PLUGIN_DIALOG__.open(...)`:

```javascript
  $('btnOpen').addEventListener('click', async () => {
    if (window.__TAURI__) {
      try {
        const invoke = window.__TAURI__.core ? window.__TAURI__.core.invoke : window.__TAURI__.invoke;
        let selectedPath = null;
        if (window.__TAURI_PLUGIN_DIALOG__ && window.__TAURI_PLUGIN_DIALOG__.open) {
          const res = await window.__TAURI_PLUGIN_DIALOG__.open({ filters: [{ name: 'PDF', extensions: ['pdf'] }] });
          selectedPath = typeof res === 'string' ? res : (res && res.path);
        } else if (invoke) {
          const res = await invoke('plugin:dialog|open', {
            multiple: false,
            directory: false,
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
          });
          selectedPath = typeof res === 'string' ? res : (res && res.path);
        }

        if (selectedPath) {
          const infos = await invoke('open_pdf', { pathStr: selectedPath });
          state.pageInfos = infos;
          state.strokes = [];
          state.selectedStrokes = [];
          state.undoStack = [];
          state.redoStack = [];
          tileCache.clear();
          goToPage(0);
          $('docInfo').innerHTML = `
            <div>Loaded: ${selectedPath.split('\\').pop().split('/').pop()}</div>
            <div>Pages: ${infos.length}</div>
          `;
          return;
        }
      } catch (err) {
        console.warn('Tauri dialog failed, using file picker input fallback:', err);
      }
    }
    $('pdfFileInput') && $('pdfFileInput').click();
  });
```

### Step 2: Ensure capability permissions in `capabilities/default.json`

In `inkwell-app/src-tauri/capabilities/default.json`:
Verify permission `dialog:allow-open` is present under `"permissions"`.

**Verify**: Check `capabilities/default.json` content.

## Done criteria

- [ ] `btnOpen` successfully invokes native dialog via Tauri v2 plugin.
- [ ] Fallback to file picker remains available if running in web browser.
- [ ] `plans/README.md` updated.
