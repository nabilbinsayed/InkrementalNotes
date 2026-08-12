# Plan 018: Add Header Open PDF Button, File Drag-and-Drop, & Canvas Welcome Dropzone

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat HEAD -- inkwell-app/src/index.html inkwell-app/src/js/app.js inkwell-app/src/styles.css`

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `HEAD`, 2026-08-12

## Why this matters

Currently, there is no visible "Open PDF" button anywhere on the main interface (Top Header bar, Navigation Rail, or Canvas Stage). The `#btnOpen` button and `#pdfFileInput` are hidden deep inside `#drawerDocInfo`, which is collapsed by default. Additionally, dropping a `.pdf` file onto the window does nothing because drag-and-drop event listeners are missing. 

This plan places a prominent "📂 Open PDF" button directly in the main top header bar, adds native drag-and-drop file opening support to the canvas, and displays a clean glassmorphic welcome dropzone when no PDF document is open.

## Current state

- `inkwell-app/src/index.html:105-115` — `#btnOpen` is placed inside `#drawerDocInfo` (`hidden`).
- `inkwell-app/src/index.html:148-180` — Top header `.header-left` contains back/forward navigation buttons but lacks an "Open PDF" button.
- `inkwell-app/src/js/app.js:1550` — `btnNewTab` attempts `$('btnOpen').click()`, which fails if `#btnOpen` is hidden or missing.
- `inkwell-app/src/js/app.js:1767` — Startup code initializes a dummy tab titled `"Lecture 07 — Fourier Series.pdf"` with 0 pages instead of a clear welcome state.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Playwright Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, 46/46 pass |
| Rust Clippy | `cd inkwell; cargo clippy --all-targets` | exit 0, 0 warnings |
| Tauri Host Build | `cd inkwell-app/src-tauri; cargo build` | exit 0, compilation succeeds |

## Scope

**In scope**:
- `inkwell-app/src/index.html` — Add `#btnHeaderOpen` to `.header-left`, add `#welcomeDropzone` overlay to `#stage`.
- `inkwell-app/src/styles.css` — Style `#btnHeaderOpen` and `#welcomeDropzone` glassmorphic CTA card.
- `inkwell-app/src/js/app.js` — Bind `#btnHeaderOpen` directly to file opening logic, bind `dragover`/`drop` handlers to `#stage` and `window`, replace dummy tab with clean empty state when no pages are loaded.
- `inkwell-app/src-tauri/capabilities/default.json` — Add `"dialog:allow-save"` permission.

**Out of scope**:
- Rust core math (`inkwell-core`) or PDF rendering pipeline (`inkwell-pdf`).

## Steps

### Step 1: Add Primary Open PDF Button & Welcome Dropzone HTML (`index.html`)

1. In `inkwell-app/src/index.html`, inside `.header-left` (after `#btnNavForward`), add:
```html
<button id="btnHeaderOpen" class="btn btn-primary-accent" title="Open PDF File (Ctrl+O)" aria-label="Open PDF File">
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></svg>
  <span>Open PDF</span>
</button>
```

2. Inside `#stage`, add a centered welcome overlay `#welcomeDropzone`:
```html
<div id="welcomeDropzone" class="welcome-dropzone">
  <div class="welcome-card">
    <div class="welcome-icon">📄</div>
    <h2>No PDF Document Loaded</h2>
    <p>Drag and drop a PDF file anywhere here, or click below to browse</p>
    <button id="btnWelcomeOpen" class="btn btn-hero">📂 Open PDF Document</button>
  </div>
</div>
```

**Verify**: Check that `index.html` contains `#btnHeaderOpen` and `#welcomeDropzone`.

### Step 2: Add Glassmorphic Styling for Open Button & Welcome Dropzone (`styles.css`)

1. In `inkwell-app/src/styles.css`, add styles for `.btn-primary-accent` and `.welcome-dropzone`:
```css
.btn-primary-accent {
  background: var(--accent-purple, #7C3AED);
  color: #ffffff;
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease;
}
.btn-primary-accent:hover {
  background: #6D28D9;
  transform: translateY(-1px);
}

.welcome-dropzone {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 17, 23, 0.85);
  backdrop-filter: blur(12px);
}
.welcome-dropzone.hidden { display: none; }
.welcome-card {
  text-align: center;
  background: rgba(28, 31, 46, 0.9);
  border: 2px dashed rgba(124, 58, 237, 0.5);
  border-radius: 20px;
  padding: 40px 48px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  max-width: 440px;
}
.welcome-card.drag-over {
  border-color: #7C3AED;
  background: rgba(124, 58, 237, 0.15);
}
.welcome-icon { font-size: 48px; margin-bottom: 12px; }
.welcome-card h2 { font-size: 20px; font-weight: 700; margin-bottom: 8px; color: #f3f4f6; }
.welcome-card p { font-size: 13px; color: #9ca3af; margin-bottom: 20px; line-height: 1.5; }
.btn-hero {
  background: #7C3AED;
  color: #fff;
  border: none;
  border-radius: 10px;
  padding: 10px 24px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
```

**Verify**: `styles.css` includes `.btn-primary-accent` and `.welcome-dropzone`.

### Step 3: Wire Open PDF & Drag-and-Drop Event Handlers (`app.js`)

1. In `inkwell-app/src/js/app.js`, bind `#btnHeaderOpen` and `#btnWelcomeOpen` to trigger file selection.
2. Update `handlePdfLoadSuccess` to hide `#welcomeDropzone`:
```javascript
if ($('welcomeDropzone')) $('welcomeDropzone').classList.add('hidden');
```
3. Add drag-and-drop listeners to `window` and `#stage`:
```javascript
window.addEventListener('dragover', e => {
  e.preventDefault();
  if ($('welcomeDropzone')) $('welcomeDropzone').classList.remove('hidden');
  const card = document.querySelector('.welcome-card');
  if (card) card.classList.add('drag-over');
});

window.addEventListener('dragleave', e => {
  if (e.clientX <= 0 || e.clientY <= 0) {
    const card = document.querySelector('.welcome-card');
    if (card) card.classList.remove('drag-over');
  }
});

window.addEventListener('drop', async e => {
  e.preventDefault();
  const card = document.querySelector('.welcome-card');
  if (card) card.classList.remove('drag-over');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
    const invoke = getInvoke();
    const filePath = file.path || file.webkitRelativePath;
    if (filePath && invoke) {
      const infos = await invoke('open_pdf', { pathStr: filePath });
      handlePdfLoadSuccess(file.name, filePath, infos);
    }
  }
});
```

**Verify**: `cd inkwell-m0; py -3 test_smoke.py` → 18/18 pass.

### Step 4: Add Missing `dialog:allow-save` Permission (`default.json`)

In `inkwell-app/src-tauri/capabilities/default.json`, add `"dialog:allow-save"`:
```json
{
  "identifier": "default",
  "description": "Default Inkwell capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "dialog:allow-save"
  ]
}
```

**Verify**: `cd inkwell-app/src-tauri; cargo build` → compilation succeeds with exit 0.

## Done criteria

- [ ] Header contains visible "📂 Open PDF" button (`#btnHeaderOpen`)
- [ ] Canvas displays welcome dropzone overlay (`#welcomeDropzone`) when no PDF is active
- [ ] Dragging and dropping a `.pdf` file onto the window triggers PDF loading
- [ ] Playwright smoke test passes (`18/18`)
- [ ] Rust tests pass (`46/46`)
- [ ] `plans/README.md` updated
