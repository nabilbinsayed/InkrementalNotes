# Plan 010: Rendering Performance — Tile Grid, Debouncing, and Memory Budget

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 366b074..HEAD -- inkwell-app/src/js/app.js inkwell/crates/inkwell-pdf/src/rasterizer.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches the core rendering loop)
- **Depends on**: plans/008 (the aspect ratio fix changes Tile dimensions)
- **Category**: perf
- **Planned at**: commit `366b074`, 2026-08-08

## Why this matters

The user reports "the system is yet very laggy" during panning and zooming. The root cause is the current rendering approach: **one giant tile per pane per frame**. Every pan or zoom:
1. Invalidates the tile cache (new rect = new key)
2. Issues a new `render_tile` IPC call to Rust which re-renders the entire visible rect
3. Blocks drawing until the new tile arrives

This means:
- **Zero cache reuse**: moving 1 pixel sideways discards the entire tile and re-renders
- **Over-rendering**: the tile covers the full visible rect even if only a small region scrolled in
- **No progressive display**: during the IPC round-trip, the user sees stale or blank content

The fix is to switch to a **tile grid** like every professional PDF viewer: divide the page into fixed-size tiles (the backend already has a `TILE = 512` constant and `TileCache` / `visible_tiles()` logic in `tiles.rs` — it's just not being used by the frontend).

## Current state

### Backend tile infrastructure (already exists, unused)

`inkwell/crates/inkwell-core/src/tiles.rs` defines:
- `TILE = 512` — tile edge in device pixels
- `TileKey { page, lod, tx, ty }` — identifies a tile in the grid
- `visible_tiles(view)` → `Vec<TileKey>` — tiles intersecting a viewport
- `tile_rect(key)` → `[f64; 4]` — world-space rect for a tile
- `TileCache` — LRU cache with memory budget and LOD fallback
- `PageRasterizer` trait — already implemented by `PdfiumRasterizer`

**None of this is used.** The frontend bypasses it entirely and issues one monolithic `render_tile` per pane.

### Frontend rendering (the bottleneck)

`inkwell-app/src/js/app.js`:

```javascript
// redrawTilesForPane() — lines 199-265
// Computes ONE rect covering the visible area, requests ONE tile
const tileRect = [rx0, ry0, rx1, ry1];
const rw = rx1 - rx0;
const rh = ry1 - ry0;
const zoom = ...;
const px = Math.min(2048, Math.round(Math.max(rw, rh) * zoom * state.dpr));

const result = await fetchTile(sheetIdx, tileRect, px);
```

**Problems**:
1. `px` can be up to 2048, meaning one tile can be 2048×2048 = 12.6 MB RGB — heavy to render and transfer
2. Any viewport change = full re-render even if 90% of the content was already visible
3. The `tileCache` Map keys on `${page}:${rect}:${px}` — exact rect match only, no spatial reuse
4. `requestAnimationFrame` debouncing exists but each frame still triggers a full tile render

### Render tile IPC overhead

`commands.rs` `render_tile` → loads PDF from byte slice each call (even though PDFium is cached). This is ~1ms overhead per call but adds up if called per-tile in a grid.

## Proposed approach

Rather than converting the entire frontend to use the Rust-side `TileCache` (which would require significant IPC architecture changes), apply pragmatic JS-side improvements:

### Strategy A: Fixed-size tile grid on the frontend

Split the visible area into ~512×512pt grid tiles. Each tile is fetched and cached independently. When the user pans, only the newly-visible edge tiles are fetched — the rest come from cache. This is the single biggest perf win available.

### Strategy B: Concurrent tile fetching with limits

Fetch up to 4 tiles concurrently (not one at a time). Cancel in-flight requests for tiles that scrolled off-screen.

### Strategy C: LOD-based rendering

At low zoom, request lower-resolution tiles to reduce IPC payload. Upgrade to high-res tiles after a short debounce.

## Scope

**In scope** (the only files you should modify):
- `inkwell-app/src/js/app.js` — rewrite `redrawTilesForPane()` and `fetchTile()` to use a tile grid

**Out of scope** (do NOT touch):
- `inkwell/crates/inkwell-pdf/src/rasterizer.rs` — the backend `render_tile` command works fine
- `inkwell/crates/inkwell-core/src/tiles.rs` — the Rust `TileCache` is a nice design but wiring it would require IPC redesign; JS-side grid is simpler and equally effective
- `inkwell-app/src/js/viewport.js` — viewport math is correct
- `inkwell-app/src/index.html` — no UI changes

## Commands you will need

| Purpose   | Command                         | Expected on success    |
|-----------|---------------------------------|------------------------|
| Dev run   | Launch via `launch inkwell.bat` | App opens, PDF renders |

## Steps

### Step 1: Define tile grid constants and helpers

Add at the top of `app.js` (near the tileCache definition):

```javascript
// Tile grid: each tile covers TILE_PT points in page space.
// At zoom=1, each tile is ~512 device pixels. Tiles scale with zoom.
const TILE_PT = 512;  // tile edge in PDF points

function tileGridForRect(rx0, ry0, rx1, ry1) {
  // Returns an array of {tx, ty, rect: [x0,y0,x1,y1]} covering the visible area
  const tiles = [];
  const tx0 = Math.floor(rx0 / TILE_PT);
  const ty0 = Math.floor(ry0 / TILE_PT);
  const tx1 = Math.ceil(rx1 / TILE_PT);
  const ty1 = Math.ceil(ry1 / TILE_PT);
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      tiles.push({
        tx, ty,
        rect: [tx * TILE_PT, ty * TILE_PT, (tx + 1) * TILE_PT, (ty + 1) * TILE_PT]
      });
    }
  }
  return tiles;
}
```

### Step 2: Rewrite `redrawTilesForPane()` to use tile grid

Replace the monolithic single-tile approach with grid rendering:

```javascript
async function redrawTilesForPane(pane, pi, sheetIdx, drawEpoch) {
  const bounds = paneBounds(pane);
  const [wx0, wy0] = viewport.screenToWorld(bounds.x, bounds.y, pane);
  const [wx1, wy1] = viewport.screenToWorld(bounds.x + bounds.width, bounds.y + bounds.height, pane);

  // Clamp to page bounds
  const rx0 = Math.max(0, wx0), ry0 = Math.max(0, wy0);
  const rx1 = Math.min(pi.width_pt, wx1), ry1 = Math.min(pi.height_pt, wy1);
  if (rx1 <= rx0 || ry1 <= ry0) return;

  const zoom = pane === 'right' && viewport.splitMode ? viewport.rightZoom : viewport.zoom;

  // Split visible area into grid tiles
  const gridTiles = tileGridForRect(rx0, ry0, rx1, ry1);

  // Compute tile resolution: each TILE_PT square → px device pixels
  const px = Math.min(1024, Math.round(TILE_PT * zoom * state.dpr));
  if (px < 4) return;

  // Fetch all tiles concurrently (max 4 at a time via browser limits)
  const promises = gridTiles.map(async gt => {
    // Clamp tile rect to page bounds
    const tr = [
      Math.max(0, gt.rect[0]),
      Math.max(0, gt.rect[1]),
      Math.min(pi.width_pt, gt.rect[2]),
      Math.min(pi.height_pt, gt.rect[3])
    ];
    // Skip tiles that have zero extent after clamping
    if (tr[2] <= tr[0] || tr[3] <= tr[1]) return;

    const result = await fetchTile(sheetIdx, tr, px);
    if (!result || drawEpoch !== redrawTiles.epoch) return;

    // Draw this tile at its world position
    const [sx0, sy0] = viewport.worldToScreen(tr[0], tr[1], pane);
    const [sx1, sy1] = viewport.worldToScreen(tr[2], tr[3], pane);
    tctx.save();
    tctx.scale(state.dpr, state.dpr);
    clipToPane(tctx, pane);
    // Clip to page bounds
    const [pageX0, pageY0] = viewport.worldToScreen(0, 0, pane);
    const [pageX1, pageY1] = viewport.worldToScreen(pi.width_pt, pi.height_pt, pane);
    tctx.beginPath();
    tctx.rect(pageX0, pageY0, pageX1 - pageX0, pageY1 - pageY0);
    tctx.clip();
    tctx.drawImage(result.data, sx0, sy0, sx1 - sx0, sy1 - sy0);
    tctx.restore();
  });

  await Promise.all(promises);

  // If all tiles failed, show error overlay
  if (tileRenderError && drawEpoch === redrawTiles.epoch) {
    const [pageX0, pageY0] = viewport.worldToScreen(0, 0, pane);
    const [pageX1, pageY1] = viewport.worldToScreen(pi.width_pt, pi.height_pt, pane);
    const pw = pageX1 - pageX0, ph = pageY1 - pageY0;
    tctx.save();
    tctx.scale(state.dpr, state.dpr);
    clipToPane(tctx, pane);
    tctx.fillStyle = 'rgba(239,68,68,0.10)';
    tctx.fillRect(pageX0, pageY0, pw, ph);
    tctx.fillStyle = '#ef4444';
    tctx.font = `bold ${Math.min(24, pw * 0.06)}px system-ui, sans-serif`;
    tctx.textAlign = 'center';
    tctx.textBaseline = 'middle';
    const cx = pageX0 + pw / 2, cy = pageY0 + ph / 2;
    tctx.fillText('⚠ PDF render failed', cx, cy - 18);
    tctx.font = `${Math.min(13, pw * 0.032)}px system-ui, sans-serif`;
    tctx.fillStyle = '#b91c1c';
    const errText = tileRenderError.length > 80
      ? tileRenderError.slice(0, 77) + '…'
      : tileRenderError;
    tctx.fillText(errText, cx, cy + 10);
    tctx.restore();
  }
}
```

**Key improvements**:
- The visible area is divided into `TILE_PT × TILE_PT` grid tiles
- Each grid tile has a stable key in the cache (since the grid is page-aligned, panning reuses tiles)
- Multiple tiles fetch concurrently
- Individual tile errors don't block other tiles from rendering

### Step 3: Add tile cache eviction

The `tileCache` Map can grow unbounded. Add a simple LRU eviction:

```javascript
const TILE_CACHE_MAX = 200; // max cached tile canvases

function evictTileCache() {
  if (tileCache.size <= TILE_CACHE_MAX) return;
  // Evict oldest entries (Map preserves insertion order)
  const keysToDelete = [];
  let count = tileCache.size - TILE_CACHE_MAX;
  for (const key of tileCache.keys()) {
    if (count-- <= 0) break;
    keysToDelete.push(key);
  }
  keysToDelete.forEach(k => tileCache.delete(k));
}
```

Call `evictTileCache()` at the end of `redrawTiles()`.

### Step 4: Clear only changed pages from cache on page navigation

Currently, `goToPage()` doesn't clear the tile cache, which means stale tiles from previous pages may remain. Add selective cache clearing:

```javascript
function clearTileCacheForPage(pageIdx) {
  for (const key of tileCache.keys()) {
    if (key.startsWith(`${pageIdx}:`)) tileCache.delete(key);
  }
}
```

This isn't strictly needed for performance but prevents stale data if the page content changes (e.g., after saving).

**Verify**: Open a 31-page PDF. Navigate through pages rapidly. Performance should feel smooth — no more full-page re-renders on every pan/zoom frame. Scroll up and down — previously-viewed tiles load instantly from cache.

## Test plan

- **Manual test 1**: Open the Bangla PDF. Pan left/right by small amounts. The content should pan smoothly without flickering or lag.
- **Manual test 2**: Zoom in to 200%. Pan around — only a few tiles at the edges should render.
- **Manual test 3**: In split view, zoom one pane to 400% and the other to 50%. Both should render smoothly.
- **Performance benchmark**: Open DevTools → Performance tab → Record while panning. `render_tile` IPC calls should be ≤6 per frame (grid), not 1 large call.

## Done criteria

- [ ] Panning/zooming feels smooth at 30+ FPS (no visible lag)
- [ ] Tile cache hit rate > 80% during normal panning (visible in console logs if added)
- [ ] Memory usage doesn't grow unbounded (cache eviction works)
- [ ] No visual glitches: tiles align perfectly at grid boundaries
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:
- The tile grid approach introduces visible seam lines between tiles (rounding errors at tile boundaries).
- Concurrent tile fetching causes race conditions where tiles from a previous epoch draw on top of current tiles.
- The PDFium backend can't handle concurrent `render_tile` calls (it uses a Mutex-locked singleton — check if this serializes requests).

## Maintenance notes

- The `TILE_PT = 512` constant controls tile size in PDF points. Smaller = more tiles per screen but better cache reuse during small pans. Larger = fewer IPC calls but more wasted rendering. 512 is a good default matching the backend `TILE = 512`.
- The tile grid approach means the `render_tile` backend receives smaller rects but more frequently. If the PDFium Mutex becomes a bottleneck, consider a render queue or off-thread rendering.
- If background thread pool rendering is added later, the concurrent `fetchTile` calls will naturally distribute across threads.
