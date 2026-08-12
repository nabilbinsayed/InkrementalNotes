# Plan 019: Fix Native File Dialog Deadlock & File Input DOM Placement

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell-app/src/index.html inkwell-app/src/js/app.js`

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 018
- **Category**: bug
- **Planned at**: commit `HEAD`, 2026-08-12

## Why this matters

Clicking "Browse PDF Files" or "Open PDF" was failing for two reasons:
1. In `commands.rs`, `open_pdf_dialog` used `tx.blocking_send` inside a `pick_file` callback on Tokio's async runtime thread, causing a Tokio thread deadlock when `.await`ing `rx.recv()`.
2. In `index.html`, `<input type="file" id="pdfFileInput">` was placed inside `#drawerDocInfo` (`display: none`). WebView2 and Chrome security policies reject `.click()` calls dispatched to file inputs nested inside `display: none` parent elements.

This plan fixes the Rust async deadlock by using `tauri::async_runtime::spawn_blocking` with `.blocking_pick_file()`, and moves `#pdfFileInput` to top-level `<body>` so file input clicks work 100% reliably in both native desktop host and browser fallback modes.

## Current state

- `inkwell-app/src-tauri/src/commands.rs:137-158` — `open_pdf_dialog` deadlocks when `tx.blocking_send` is called inside callback.
- `inkwell-app/src/index.html:111` — `<input type="file" id="pdfFileInput">` is nested inside `#drawerDocInfo` (`hidden` / `display: none`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Playwright Smoke Test | `cd inkwell-m0; py -3 test_smoke.py` | exit 0, 18/18 pass |
| Rust Core Tests | `cd inkwell; cargo test` | exit 0, 46/46 pass |
| Rust Clippy | `cd inkwell; cargo clippy --all-targets` | exit 0, 0 warnings |
| Tauri Host Build | `cd inkwell-app/src-tauri; cargo build` | exit 0, compilation succeeds |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs` — Replace deadlocking async callback channel in `open_pdf_dialog` with `tauri::async_runtime::spawn_blocking` + `.blocking_pick_file()`.
- `inkwell-app/src/index.html` — Move `#pdfFileInput` to top-level `<body>` directly.
- `inkwell-app/src/js/app.js` — Ensure `triggerOpen` handles native dialog result and fallback cleanly.

**Out of scope**:
- Rust core math (`inkwell-core`) or PDF rendering pipeline (`inkwell-pdf`).

## Steps

### Step 1: Fix Native File Dialog Command in Rust (`commands.rs`)

In `inkwell-app/src-tauri/src/commands.rs`, update `open_pdf_dialog`:

```rust
#[tauri::command]
pub async fn open_pdf_dialog(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(String, Vec<PageInfo>), String> {
    let file_option = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("PDF Document", &["pdf"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(path) = file_option {
        let path_buf = path.into_path().map_err(|e| e.to_string())?;
        let path_str = path_buf.to_string_lossy().to_string();
        let infos = open_pdf(path_str.clone(), state)?;
        Ok((path_str, infos))
    } else {
        Err("CANCELLED".to_string())
    }
}
```

**Verify**: `cd inkwell-app/src-tauri; cargo build` → exit 0, clean compilation without warnings.

### Step 2: Relocate `#pdfFileInput` to Body Top-Level (`index.html`)

In `inkwell-app/src/index.html`:
1. Remove `<input type="file" id="pdfFileInput" accept="application/pdf,.pdf" style="display:none;">` from `#drawerDocInfo`.
2. Insert `<input type="file" id="pdfFileInput" accept="application/pdf,.pdf" style="display:none;">` directly under `<body>` (right before `#app-container`).

**Verify**: Inspect `index.html` to confirm `#pdfFileInput` is directly under `<body>`.

### Step 3: Polish Frontend Open Listener (`app.js`)

In `inkwell-app/src/js/app.js`, update `attachOpenListeners()`:

```javascript
  const triggerOpen = async () => {
    const invoke = getInvoke();
    if (invoke) {
      try {
        const res = await invoke('open_pdf_dialog');
        if (res && res[0]) {
          const selectedPath = res[0];
          const infos = res[1];
          const title = selectedPath.split('\\').pop().split('/').pop();
          handlePdfLoadSuccess(title, selectedPath, infos);
        }
        return;
      } catch (err) {
        if (err === 'CANCELLED' || err === 'No file selected') return;
        console.warn('[inkwell] Native open_pdf_dialog failed, trying file input:', err);
      }
    }
    if ($('pdfFileInput')) $('pdfFileInput').click();
  };
```

**Verify**: Run `cd inkwell-m0; py -3 test_smoke.py` → exit 0, 18/18 checks pass.

## Done criteria

- [ ] Native file dialog opens Windows file picker without locking or deadlocking
- [ ] Clicking "Browse PDF Files" or "Open PDF" opens the file picker in native app and browser fallback modes
- [ ] Playwright smoke suite passes (`18/18`)
- [ ] Cargo build compiles `inkwell-app.exe` with exit 0
