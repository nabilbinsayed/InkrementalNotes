# Plan 008: Fix PDF Page Positioning and Aspect Ratio Distortion

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 366b074..HEAD -- inkwell/crates/inkwell-pdf/src/rasterizer.rs inkwell-app/src/js/app.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0 (critical visual bug — the most visible remaining defect)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `366b074`, 2026-08-08

## Why this matters

The PDF page content is visually distorted (horizontally stretched) when rendered in InkWell compared to how it looks in standard PDF viewers like Edge or Adobe Reader. This is the single most visible remaining defect — every page of every PDF looks wrong. Users have confirmed this by comparing InkWell screenshots against Edge screenshots of the same PDF.

**Root Cause**: The rasterizer renders the entire page into a non-square bitmap (width≠height because most PDFs are portrait or landscape), but stores the result in a `px × px` square tile buffer. The frontend then stretches this square tile to fill the rectangular page area via `drawImage()`, causing the content to be horizontally stretched (for portrait pages) or vertically stretched (for landscape pages).

Specifically:
1. `rasterize()` computes `scale = px / max(rw, rh)`, producing `target_w = page_w * scale` and `target_h = page_h * scale`. For a portrait A4 page (595×842pt), requesting px=1000: `scale = 1000/842 ≈ 1.188`, `target_w ≈ 707`, `target_h = 1000`.
2. The actual PDFium bitmap is 707×1000 pixels, but it's placed into a 1000×1000 `rgb_data` buffer (right ~293px are white fill).
3. The tile is returned as `Tile { w: px, h: px }` = 1000×1000.
4. The frontend's `drawImage()` maps this 1000×1000 tile onto the full page width/height screen rect, stretching the 707px content to span what should be 1000px worth of page width → **horizontal distortion**.

## Current state

### `inkwell/crates/inkwell-pdf/src/rasterizer.rs` (lines 23–95)

The `rasterize()` function receives `rect` (the visible portion of the page in PDF points) and `px` (desired tile edge in device pixels). The critical code:

```rust
// Line 33: scale based on max dimension of the requested rect
let scale = (px as f64) / rw.max(rh);
// Line 34-35: render entire page at this scale
let target_w = (page_w * scale).round().max(1.0) as i32;
let target_h = (page_h * scale).round().max(1.0) as i32;

// Line 37-40: configure PDFium render
let config = PdfRenderConfig::new()
    .set_target_width(target_w)
    .set_maximum_height(target_h)
    .set_clear_color(PdfColor::WHITE);

// Line 50-51: crop position
let x0 = (rect[0] * scale).round().max(0.0) as u32;
let y0 = (rect[1] * scale).round().max(0.0) as u32;

// Line 53: output buffer is always px × px
let mut rgb_data = vec![255; (px * px * 3) as usize];
```

**Problem**: When `rect` is the full page, `rw = 595`, `rh = 842`, `max = 842`, `scale = px/842`. The bitmap is `707×1000` but the tile buffer is `1000×1000`. The content occupies only the top-left `707×1000` portion, and the rest is white padding. The frontend stretches this `1000×1000` tile to fill the page rect, distorting it.

### `inkwell-app/src/js/app.js` (lines 199–264)

The `redrawTilesForPane()` function computes the visible rect, requests a tile, and draws it:

```javascript
// Line 208: tile rect is the visible portion of the page
const tileRect = [rx0, ry0, rx1, ry1];
const rw = rx1 - rx0;
const rh = ry1 - ry0;
const zoom = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;
// Line 212: px computed from max dimension
const px = Math.min(2048, Math.round(Math.max(rw, rh) * zoom * state.dpr));

// Line 253-263: draw tile stretched to fill world-space rect
const [sx0, sy0] = viewport.worldToScreen(tileRect[0], tileRect[1], pane);
const [sx1, sy1] = viewport.worldToScreen(tileRect[2], tileRect[3], pane);
tctx.drawImage(result.data, sx0, sy0, sx1 - sx0, sy1 - sy0);
```

**Problem**: `drawImage()` stretches the entire `px×px` tile canvas (including white padding) to fill the `(sx1-sx0) × (sy1-sy0)` screen rect, which has different aspect ratio from the tile content.

## Commands you will need

| Purpose   | Command                                                                                   | Expected on success |
|-----------|-------------------------------------------------------------------------------------------|---------------------|
| Build     | `cargo build --manifest-path inkwell/Cargo.toml`                                          | exit 0              |
| Test      | `cargo test --workspace --manifest-path inkwell/Cargo.toml`                               | all pass            |
| Dev run   | Launch via `launch inkwell.bat` and open a PDF                                            | PDF renders undistorted |

## Scope

**In scope** (the only files you should modify):
- `inkwell/crates/inkwell-pdf/src/rasterizer.rs`
- `inkwell-app/src/js/app.js` (only the `redrawTilesForPane` and `fetchTile` functions)

**Out of scope** (do NOT touch):
- `inkwell/crates/inkwell-core/src/pdf.rs` — annotation saving, separate concern
- `inkwell/crates/inkwell-core/src/tiles.rs` — the `Tile` struct and `TileCache` are fine
- `inkwell-app/src/js/viewport.js` — pan/zoom math is correct
- `inkwell-app/src/index.html` — no UI changes needed for this fix

## Steps

### Step 1: Fix the rasterizer to produce correctly-sized tiles

The fix: instead of rendering the entire page and then cropping, render only the requested `rect` region. Compute separate scale factors for width and height of the *requested rect*, not the page, and produce a bitmap that exactly covers the rect.

Edit `inkwell/crates/inkwell-pdf/src/rasterizer.rs`, replace the `rasterize()` method:

```rust
fn rasterize(&self, page: u32, rect: [f64; 4], px: u32) -> Option<Tile> {
    let p = self.document.pages().get(page as i32).ok()?;

    let rw = (rect[2] - rect[0]).max(1.0);
    let rh = (rect[3] - rect[1]).max(1.0);

    let page_w = p.width().value as f64;
    let page_h = p.height().value as f64;

    // Compute separate pixel dimensions for width and height of the
    // requested rect, preserving its aspect ratio within the px budget.
    let scale = (px as f64) / rw.max(rh);
    let out_w = (rw * scale).round().max(1.0) as u32;
    let out_h = (rh * scale).round().max(1.0) as u32;

    // Render the entire page at scale, then crop to the rect.
    let target_w = (page_w * scale).round().max(1.0) as i32;
    let target_h = (page_h * scale).round().max(1.0) as i32;

    let config = PdfRenderConfig::new()
        .set_target_width(target_w)
        .set_maximum_height(target_h)
        .set_clear_color(PdfColor::WHITE);

    let bitmap = p.render_with_config(&config).map_err(|e| {
        eprintln!("PDFium failed to render page {page}: {e:?}");
        e
    }).ok()?;
    let bgra_bytes = bitmap.as_raw_bytes();
    let bitmap_w = bitmap.width() as u32;
    let bitmap_h = bitmap.height() as u32;

    let x0 = (rect[0] * scale).round().max(0.0) as u32;
    let y0 = (rect[1] * scale).round().max(0.0) as u32;

    // Output buffer sized to actual content, NOT px×px square.
    let mut rgb_data = vec![255; (out_w * out_h * 3) as usize];

    if x0 >= bitmap_w || y0 >= bitmap_h {
        return Some(Tile {
            w: out_w,
            h: out_h,
            data: rgb_data,
        });
    }

    let crop_w = out_w.min(bitmap_w.saturating_sub(x0));
    let crop_h = out_h.min(bitmap_h.saturating_sub(y0));

    for y in 0..crop_h {
        for x in 0..crop_w {
            let src_idx = ((y0 + y) * bitmap_w + (x0 + x)) as usize * 4;
            let dst_idx = (y * out_w + x) as usize * 3;

            if src_idx + 3 < bgra_bytes.len() {
                let b = bgra_bytes[src_idx];
                let g = bgra_bytes[src_idx + 1];
                let r = bgra_bytes[src_idx + 2];
                let a = bgra_bytes[src_idx + 3] as u32;

                // Alpha-blend over white background
                let blended_r = ((r as u32 * a + 255 * (255 - a)) / 255) as u8;
                let blended_g = ((g as u32 * a + 255 * (255 - a)) / 255) as u8;
                let blended_b = ((b as u32 * a + 255 * (255 - a)) / 255) as u8;

                rgb_data[dst_idx] = blended_r;
                rgb_data[dst_idx + 1] = blended_g;
                rgb_data[dst_idx + 2] = blended_b;
            }
        }
    }

    Some(Tile {
        w: out_w,
        h: out_h,
        data: rgb_data,
    })
}
```

**Key changes**:
- `out_w` and `out_h` are computed from the *rect* dimensions (not forced to `px × px`)
- The output `rgb_data` buffer is `out_w × out_h` (not `px × px`)
- The `Tile` is returned with `w: out_w, h: out_h`
- No more white padding; the tile exactly covers its requested rect

**Verify**: `cargo build --manifest-path inkwell/Cargo.toml` → exit 0

### Step 2: Update the frontend tile buffer validation and drawing

The backend now returns non-square tiles. The frontend must:
1. Accept tiles where `data.length = w * h * 3` (not necessarily `px * px * 3`)
2. Create the `ImageData` and tile canvas with the actual `w × h` dimensions

Edit `inkwell-app/src/js/app.js`, in the `fetchTile()` function:

**Replace** the raw buffer validation and ImageData creation section (currently around lines 98-114):

```javascript
async function fetchTile(page, rect, px) {
  const invoke = getInvoke();
  if (!invoke) return null;
  const key = `${page}:${rect.join(',')}:${px}`;
  if (tileCache.has(key)) return { key, data: tileCache.get(key) };
  if (tilesPending.has(key)) return tilesPending.get(key);

  const task = (async () => {
    try {
    const raw = await invoke('render_tile', { page, rect, px });
    // The backend returns tiles that may be non-square: w×h where
    // w,h ≤ px. Compute expected dimensions from the rect aspect ratio.
    const rw = rect[2] - rect[0];
    const rh = rect[3] - rect[1];
    const scale = px / Math.max(rw, rh);
    const tileW = Math.round(rw * scale) || 1;
    const tileH = Math.round(rh * scale) || 1;
    const expectedBytes = tileW * tileH * 3;
    if (!raw || raw.length !== expectedBytes) {
      throw new Error(`Invalid tile buffer: expected ${expectedBytes} RGB bytes (${tileW}×${tileH}), got ${raw ? raw.length : 0}`);
    }
    const imgData = new ImageData(tileW, tileH);
    for (let i = 0; i < tileW * tileH; i++) {
      imgData.data[i * 4 + 0] = raw[i * 3 + 0];
      imgData.data[i * 4 + 1] = raw[i * 3 + 1];
      imgData.data[i * 4 + 2] = raw[i * 3 + 2];
      imgData.data[i * 4 + 3] = 255;
    }
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = tileW;
    tileCanvas.height = tileH;
    tileCanvas.getContext('2d').putImageData(imgData, 0, 0);
    tileCache.set(key, tileCanvas);
    tileRenderError = null;
    return { key, data: tileCanvas };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error('[inkwell] render_tile error:', msg);
      tileRenderError = msg;
      scheduleRedrawTiles();
      return null;
    } finally {
      tilesPending.delete(key);
    }
  })();
  tilesPending.set(key, task);
  return task;
}
```

The `drawImage()` call in `redrawTilesForPane()` (line 263) already draws the tile stretched to the world-space rect, which is now correct because the tile canvas exactly matches the rect's aspect ratio.

**Verify**: Open a PDF in InkWell. The page should appear with correct proportions matching Edge/Adobe Reader.

### Step 3: Verify with the test PDF

1. Launch InkWell via `launch inkwell.bat`
2. Open `Higher_Math_Bangla_chapter_3.pdf`
3. Compare page 1 rendering against Edge browser — text should have the same proportions and not appear squeezed or stretched
4. Navigate to multiple pages to verify consistency
5. Enable split view and confirm both panes render correctly

**Verify**: Visual comparison shows no distortion. The page content layout in InkWell matches Edge.

## Test plan

- **Existing tests**: `cargo test --workspace --manifest-path inkwell/Cargo.toml` — all pass. The `tiles.rs` tests use a stub rasterizer that returns square tiles, so they won't exercise this fix directly, but they must not regress.
- **Manual test**: Open the Bangla math PDF, visually compare with Edge at page 1, page 15, and page 31.
- **Edge case**: Open a landscape PDF (if available) to verify the fix works for both orientations.

## Done criteria

- [ ] `cargo build --manifest-path inkwell/Cargo.toml` exits 0
- [ ] `cargo test --workspace --manifest-path inkwell/Cargo.toml` exits 0; no regressions
- [ ] PDF pages render with correct aspect ratio — no horizontal or vertical stretching
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:
- The code at the locations in "Current state" doesn't match the excerpts (codebase drift).
- `render_tile` backend command returns errors after the rasterizer change.
- The `pdfium-render` crate's `PdfRenderConfig` does not support `set_target_width` / `set_maximum_height` as shown.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If the tile caching system in `tiles.rs` is changed to use `TileKey`-based rendering with fixed `TILE` edge size, the rasterizer will need to be re-verified. The `Tile` struct's `w` and `h` fields are now significant (no longer always equal to `px`).
- The frontend's `fetchTile()` recomputes `tileW` and `tileH` from the rect. If the backend ever changes how it computes output dimensions, these must stay in sync.
