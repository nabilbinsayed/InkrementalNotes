# Plan 002: PDFium Tile Rasterizer Aspect & Bounds Fix

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 80d21c6..HEAD -- inkwell/crates/inkwell-pdf/src/rasterizer.rs inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-pdf-import-pdfium-fallback.md
- **Category**: bug
- **Planned at**: commit `80d21c6`, 2026-08-08

## Why this matters

When rendering tiles for PDF pages, `inkwell_pdf::PdfiumRasterizer::rasterize` currently calculates page scaling using `scale = (px as f64) / rw.max(rh)`. For portrait pages (where page height 842 pt > page width 595 pt), requesting a square tile region where `rw = 842, rh = 842` causes `target_w = 595 * (px / 842) = 0.706 * px`. PDFium therefore renders a bitmap of width `0.706 * px`. When the viewport pans to the right side of the page (where `rect[0]` > 595), the computed crop coordinate `x0` exceeds `bitmap_w`, causing `rasterize` to fail, log an out-of-bounds error, and return `None`. In the frontend, `fetchTile` receives `null`, which causes the rendered PDF tiles to turn blank or disappear whenever the user pans or zooms into portrait/non-square pages.

## Current state

File involved:
- `inkwell/crates/inkwell-pdf/src/rasterizer.rs` (lines 23–99).
- `inkwell-app/src/js/app.js` (lines 157–190).

Excerpts from `rasterizer.rs`:
```rust
let rw = rect[2] - rect[0];
let rh = rect[3] - rect[1];
if rw <= 0.0 || rh <= 0.0 {
    eprintln!("PDFium received invalid tile rect: {rect:?}");
    return None;
}

let page_w = p.width().value as f64;
let page_h = p.height().value as f64;
let scale = (px as f64) / rw.max(rh);
let target_w = (page_w * scale).ceil().max(1.0) as i32;
let target_h = (page_h * scale).ceil().max(1.0) as i32;

let config = PdfRenderConfig::new()
    .set_target_width(target_w)
    .set_maximum_height(target_h);

let bitmap = p.render_with_config(&config)...
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust unit tests | `& "$env:USERPROFILE\.cargo\bin\cargo.exe" test --package inkwell-pdf --manifest-path inkwell/Cargo.toml` | exit 0, tests pass |
| Workspace tests | `& "$env:USERPROFILE\.cargo\bin\cargo.exe" test --workspace --manifest-path inkwell/Cargo.toml` | exit 0, all pass |

## Scope

**In scope**:
- `inkwell/crates/inkwell-pdf/src/rasterizer.rs`
- `inkwell-app/src/js/app.js`

**Out of scope**:
- `inkwell/crates/inkwell-core/src/tiles.rs` (PageRasterizer trait contract)

## Git workflow

- Commit per step; message format: `fix(pdf): correct tile rasterization scale and crop bounds`

## Steps

### Step 1: Fix scaling and crop bounds in `rasterizer.rs`

In `inkwell/crates/inkwell-pdf/src/rasterizer.rs`:
1. Calculate scale based on the requested tile rectangle dimensions `rw` and `rh` relative to tile pixel size `px`.
2. Compute `scale = (px as f64) / rw` for width scaling and `(px as f64) / rh` for height scaling, or scale the full page proportionally so the full requested `rect` is guaranteed to be rendered inside the PDFium bitmap.
3. Specifically:
```rust
let rw = (rect[2] - rect[0]).max(1.0);
let rh = (rect[3] - rect[1]).max(1.0);

let page_w = p.width().value as f64;
let page_h = p.height().value as f64;

// Compute horizontal scale factor (pixels per pt in X)
let scale_x = (px as f64) / rw;
let scale_y = (px as f64) / rh;

let target_w = (page_w * scale_x).ceil().max(1.0) as i32;
let target_h = (page_h * scale_y).ceil().max(1.0) as i32;

let config = PdfRenderConfig::new()
    .set_target_width(target_w)
    .set_maximum_height(target_h);
```
4. Update crop coordinate calculation to handle clamping safely without premature returning `None`:
```rust
let x0 = (rect[0] * scale_x).round().max(0.0) as u32;
let y0 = (rect[1] * scale_y).round().max(0.0) as u32;

let crop_w = (px as u32).min(bitmap_w.saturating_sub(x0));
let crop_h = (px as u32).min(bitmap_h.saturating_sub(y0));
```
If `crop_w == 0 || crop_h == 0`, fill the output tile buffer with white background (`255`) and return `Some(Tile)` rather than `None`, so off-page regions render cleanly as white margins without triggering console warnings or uncaught frontend errors.

**Verify**: `& "$env:USERPROFILE\.cargo\bin\cargo.exe" test --package inkwell-pdf --manifest-path inkwell/Cargo.toml` -> exit 0.

### Step 2: Ensure `redrawTilesForPane` in `app.js` passes page-bounded tile rects

In `inkwell-app/src/js/app.js`:
In `redrawTilesForPane` (lines 157–190), clamp `tileRect` so it never requests coordinates beyond `(0, 0)` to `(pi.width_pt, pi.height_pt)`.

**Verify**: Check `redrawTilesForPane` logic in `app.js`.

## Test plan

- Add a unit test in `inkwell/crates/inkwell-pdf/tests/integration.rs` verifying rasterization of non-square and portrait PDF pages across varied tile rectangles.
- Run `& "$env:USERPROFILE\.cargo\bin\cargo.exe" test --package inkwell-pdf --manifest-path inkwell/Cargo.toml`.

## Done criteria

- [ ] PDFium tile rasterizer correctly renders portrait and non-square PDF page tiles.
- [ ] Off-page margin tiles return white background pixels instead of `None`.
- [ ] `cargo test --package inkwell-pdf` passes.
- [ ] `plans/README.md` updated.

## STOP conditions

- Stop if `p.render_with_config` fails on valid PDF pages.
