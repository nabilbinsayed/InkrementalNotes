# Plan 011: Codex Handoff — Core Fixes for PDF Saved Rotation/Height, Highlighter Transparency, Sidebar Collapse, and Zoom Controls

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 366b074..HEAD -- inkwell/crates/inkwell-core/src/pdf.rs inkwell-app/src/styles.css inkwell-app/src/js/app.js inkwell-app/src/js/viewport.js inkwell-app/src/index.html`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0 (Critical data correctness, saved PDF appearance, and primary navigation UI)
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/008, plans/009, plans/010
- **Category**: bug / feature
- **Planned at**: commit `366b074`, 2026-08-08

---

## Executive Summary & Root Cause Analysis

Four primary issues remain unfixed and require targeted technical resolution:

1. **PDF Saved Annotation Position & Height Mismatch (`inkwell-core/src/pdf.rs`)**:
   - **Root Cause**: `PdfFile::page_height()` parses `/MediaBox` or `/CropBox` directly from raw PDF objects without accounting for `/Rotate` (e.g., 90° or 270° rotation) or CropBox coordinate origins `[llx, lly, urx, ury]`. Meanwhile, PDFium in the UI reports rotated page dimensions. When saving, `y_pdf = page_height - y_canvas` uses raw un-rotated MediaBox height, causing saved ink annotations to appear vertically shifted or inverted in external PDF readers like Microsoft Edge or Adobe Acrobat.
   - **Fix**: In `pdf.rs`, parse `/Rotate` and `/CropBox` / `/MediaBox` origins correctly to compute the exact page coordinate transformation matching PDFium's displayed space.

2. **Highlighter Translucency in External PDF Readers (`inkwell-core/src/pdf.rs`)**:
   - **Root Cause**: In `pdf.rs`, highlighter strokes are written with `/GSm << /Type /ExtGState /BM /Multiply /ca 0.42 >>`. However, standard PDF renderers (Adobe Acrobat, Edge, PDF.js) ignore or mis-render `/BM /Multiply` on isolated Form XObject appearance streams `/AP` unless a `/Group << /S /Transparency /CS /DeviceRGB >>` dictionary is explicitly included in the Form XObject stream dictionary.
   - **Fix**: Include `/Group << /S /Transparency /CS /DeviceRGB >>` in the Form XObject stream dictionary header when emitting highlighter stroke groups in `emit_group()`. Also specify stroking alpha `/CA 0.42` in `/GSm`.

3. **Sidebar Collapse Option Not Working (`inkwell-app/src/styles.css` & `app.js`)**:
   - **Root Cause**: `app.js` `toggleSidebar()` toggles the class `.collapsed` on `#sidebar`, but `styles.css` lacks a CSS rule for `#sidebar.collapsed`. Therefore, the sidebar remains at a fixed width of `280px` and fails to collapse.
   - **Fix**: Add `#sidebar.collapsed { display: none !important; }` and styling for the floating expand button in `styles.css`.

4. **Intuitive Variable Zoom & Zoom Toolbar Controls (`viewport.js`, `app.js`, `index.html`)**:
   - **Root Cause**: Zooming can currently only be adjusted via `Ctrl + Wheel`. There are no dedicated `Zoom In (+)`, `Zoom Out (-)`, or `Reset Zoom (Fit)` buttons in the toolbar, and trackpad pinch gestures on Windows are not smoothed.
   - **Fix**: Add dedicated Zoom In (`+`), Zoom Out (`-`), and Fit Page (`Fit`) buttons to `#toolbar` in `index.html`. Bind them in `app.js` to target the active pane (`viewport.activePane`). Smooth out pinch gestures in `viewport.js`.

---

## Current State & Excerpts

### 1. `inkwell/crates/inkwell-core/src/pdf.rs` (lines 142–165 & 201–270)

```rust
pub fn page_height(&self, page_num: u32) -> f64 {
    if let Ok(dict) = self.obj_dict(page_num) {
        let box_ref = po::dict_get(&self.base, dict, "/MediaBox")
            .or_else(|| po::dict_get(&self.base, dict, "/CropBox"));
        if let Some(r) = box_ref {
            let slice = &self.base[r.0..r.1];
            let s = String::from_utf8_lossy(slice);
            let nums: Vec<f64> = s
                .trim_matches(|c| c == '[' || c == ']')
                .split_whitespace()
                .filter_map(|t| t.parse::<f64>().ok())
                .collect();
            if nums.len() == 4 {
                let h = (nums[3] - nums[1]).abs();
                if h > 10.0 {
                    return h;
                }
            }
        }
    }
    842.0
}
```

```rust
// In emit_group():
let ap = self.add_stream(
    &format!(
        "/Type /XObject /Subtype /Form /BBox [{}] /Resources << /ExtGState << {gstates} >> >>",
        fmt_rect(&bbox_pdf)
    ),
    &content,
    true,
);
```

### 2. `inkwell-app/src/styles.css` (lines 120–132)

```css
#sidebar {
  width: 280px;
  height: 100%;
  background: var(--bg-panel);
  backdrop-filter: blur(12px);
  border-left: 1px solid var(--border);
  z-index: 10;
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 16px;
}
/* Missing #sidebar.collapsed rule! */
```

### 3. `inkwell-app/src/index.html` & `app.js`

Toolbar lacks dedicated Zoom In / Zoom Out / Reset Zoom controls.

---

## Commands You Will Need

| Purpose   | Command | Expected Output |
|-----------|---------|-----------------|
| Rust Tests | `cargo test --workspace --manifest-path inkwell/Cargo.toml` | exit 0, all 46+ tests pass |
| App Check  | `cargo check --manifest-path inkwell-app/src-tauri/Cargo.toml` | exit 0, no compilation errors |
| App Run    | Execute `launch inkwell.bat` | App launches and opens PDF cleanly |

---

## Scope

**In Scope**:
- `inkwell/crates/inkwell-core/src/pdf.rs` — page height, rotation calculation, and `/Group` transparency dictionary in `emit_group()`.
- `inkwell-app/src/styles.css` — `#sidebar.collapsed` CSS rule and responsive layout rules.
- `inkwell-app/src/index.html` — zoom controls in toolbar.
- `inkwell-app/src/js/app.js` — zoom toolbar button bindings and sidebar toggle logic.
- `inkwell-app/src/js/viewport.js` — per-pane zoom helper methods and pinch smoothing.

**Out of Scope**:
- `inkwell/crates/inkwell-pdf/src/lib.rs`
- `inkwell-app/src-tauri/src/main.rs`

---

## Detailed Implementation Steps

### Step 1: Fix Saved Annotation Position, Rotation, & Height Calculation in `pdf.rs`

In `inkwell/crates/inkwell-core/src/pdf.rs`:

1. Update `page_height()` (or add a helper `page_dimensions()`) to inspect both `/MediaBox` / `/CropBox` and `/Rotate`:
```rust
pub fn page_dimensions(&self, page_num: u32) -> (f64, f64) {
    if let Ok(dict) = self.obj_dict(page_num) {
        let rotate = po::dict_get(&self.base, dict, "/Rotate")
            .and_then(|r| po::as_int(&self.base, r))
            .unwrap_or(0);
        let box_ref = po::dict_get(&self.base, dict, "/CropBox")
            .or_else(|| po::dict_get(&self.base, dict, "/MediaBox"));
        if let Some(r) = box_ref {
            let slice = &self.base[r.0..r.1];
            let s = String::from_utf8_lossy(slice);
            let nums: Vec<f64> = s
                .trim_matches(|c| c == '[' || c == ']')
                .split_whitespace()
                .filter_map(|t| t.parse::<f64>().ok())
                .collect();
            if nums.len() == 4 {
                let w = (nums[2] - nums[0]).abs();
                let h = (nums[3] - nums[1]).abs();
                if w > 10.0 && h > 10.0 {
                    if rotate == 90 || rotate == 270 {
                        return (h, w);
                    } else {
                        return (w, h);
                    }
                }
            }
        }
    }
    (595.0, 842.0)
}
```
2. Update `page_height(&self, page_num: u32) -> f64` to return `self.page_dimensions(page_num).1`.

**Verify**: `cargo test --workspace --manifest-path inkwell/Cargo.toml` -> exit 0.

---

### Step 2: Fix Highlighter Form XObject Transparency Group in `pdf.rs`

In `inkwell/crates/inkwell-core/src/pdf.rs`, inside `emit_group()`:

1. When `needs_multiply` is true, include `/Group << /S /Transparency /CS /DeviceRGB >>` in the Form XObject stream dictionary header.
2. In `gstates`, include stroking alpha `/CA 0.42` alongside `/ca 0.42`:
```rust
let group_dict = if needs_multiply {
    " /Group << /S /Transparency /CS /DeviceRGB >>"
} else {
    ""
};

let ap = self.add_stream(
    &format!(
        "/Type /XObject /Subtype /Form{group_dict} /BBox [{}] /Resources << /ExtGState << {gstates} >> >>",
        fmt_rect(&bbox_pdf)
    ),
    &content,
    true,
);
```

3. Update `gstates`:
```rust
let mut gstates = String::from("/GSn << /Type /ExtGState /BM /Normal /ca 1 /CA 1 >>");
if needs_multiply {
    gstates.push_str(" /GSm << /Type /ExtGState /BM /Multiply /ca 0.42 /CA 0.42 >>");
}
```

**Verify**: Draw highlighter strokes in InkWell, save PDF, open in Edge/Acrobat. The highlight should render as smooth translucent yellow/color without opaque borders or dark boxes.

---

### Step 3: Implement Sidebar Collapse Rule in `styles.css`

In `inkwell-app/src/styles.css`:

Add the missing `#sidebar.collapsed` CSS rule:
```css
#sidebar.collapsed {
  display: none !important;
}
```

Ensure `#stage` expands to 100% width when `#sidebar.collapsed` is active.

**Verify**: Click the sidebar toggle button `📑` or `Ctrl+B`. The sidebar should hide completely and canvas stage should expand to fill the full window width.

---

### Step 4: Add Dedicated Zoom Toolbar Controls & Smooth Variable Zooming

1. In `inkwell-app/src/index.html`, add zoom controls to `#toolbar`:
```html
<button id="btnZoomOut" class="tool-btn" title="Zoom Out (-)">🔍-</button>
<span id="zoomLevelDisplay" style="font-size:12px; color:var(--text-muted); min-width:36px; text-align:center;">100%</span>
<button id="btnZoomIn" class="tool-btn" title="Zoom In (+)">🔍+</button>
<button id="btnZoomFit" class="tool-btn" title="Fit to Page">⤢</button>
```

2. In `inkwell-app/src/js/app.js`:
Bind `btnZoomIn`, `btnZoomOut`, `btnZoomFit`:
- `btnZoomIn`: `viewport.setZoom(curZoom * 1.25, center, pane)`
- `btnZoomOut`: `viewport.setZoom(curZoom / 1.25, center, pane)`
- `btnZoomFit`: `centerPageInPanes()`

**Verify**: Clicking `+` and `-` on the toolbar zooms the active pane in/out cleanly.

---

## Done Criteria

- [ ] All 46+ Rust workspace tests pass (`cargo test --workspace`).
- [ ] Saved PDF annotations match exact on-screen position in Microsoft Edge & Adobe Reader.
- [ ] Saved highlighter strokes maintain transparent blending in external PDF viewers.
- [ ] Right sidebar collapses completely when clicking `📑` or pressing `Ctrl+B`.
- [ ] Zoom In (+), Zoom Out (-), and Fit Page toolbar buttons work independently per pane in split view.
- [ ] `plans/README.md` is updated.

---

## STOP Conditions

Stop and report back if:
- `cargo test` fails after updating `pdf.rs`.
- ExtGState transparency dictionary changes cause shallow parser errors when reading back saved files.
