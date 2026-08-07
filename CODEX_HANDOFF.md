# Codex (GPT 5.6 Terra High) Handoff & Modular Prompt Guide

> [!IMPORTANT]
> **Token Optimization Strategy**: Because token quota in Codex is limited, do **not** let Codex scan the whole repository. Instead, feed Codex **only the specific file paths** listed for each step, and execute the task in small, modular steps.

---

## 🗺️ Whole-Codebase Architecture & Subsystem Map

> [!TIP]
> Give Codex this section first! It gives Codex **full structural understanding of the whole codebase** in under ~80 lines without consuming your token budget.

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 TAURI DESKTOP APP                       │
                  │  (inkwell-app/src-tauri & inkwell-app/src)             │
                  └────────────────────────────┬────────────────────────────┘
                                               │
               ┌───────────────────────────────┴───────────────────────────────┐
               │                                                               │
               ▼                                                               ▼
┌──────────────────────────────┐                              ┌──────────────────────────────┐
│  IPC & PDF ENGINE (Rust)     │                              │ CANVAS FRONTEND (JS / HTML)  │
│  - commands.rs (open/render) │                              │ - app.js (state & tiles)     │
│  - inkwell-pdf (PDFium lib)  │ ◄────── render_tile IPC ──── │ - ink.js (OneEuro & splines) │
│  - inkwell-core (doc & ink)  │   (page, rect, px -> RGB)    │ - viewport.js (pan/zoom transform)
│  - inkwell-wal (binary log)  │                              │ - index.html & styles.css    │
└──────────────────────────────┘                              └──────────────────────────────┘
```

### Complete End-to-End Data Flows

#### 1. PDF Loading & Tile Rasterization Flow
1. User selects PDF in UI (`app.js` -> `btnOpen` / `pdfFileInput`).
2. Frontend calls `open_pdf` or `open_pdf_bytes` IPC (`commands.rs`).
3. Rust loads PDF into PDFium (`inkwell-pdf/src/lib.rs`), retrieves `n_pages` and `[width_pt, height_pt]`, and saves raw bytes into `AppState.pdf_bytes`.
4. On pan/zoom/page-change, `redrawTiles()` in `app.js` calls `fetchTile(page, rect, px)`.
5. Frontend invokes `render_tile` IPC (`commands.rs`).
6. Rust calls `pdfium.load_pdf_from_byte_slice()`, renders visible bounding box `rect` at pixel size `px`, and returns raw `Vec<u8>` RGB bytes (`px * px * 3`).
7. Frontend `fetchTile()` wraps raw bytes into `ImageData` and blits to `#tiles` canvas (`tctx.drawImage()` / `tctx.putImageData()`).

#### 2. Digitizer Pointer & Ink Rendering Flow
1. Pen down / pointer move emits `pointerdown` / `pointermove` in `app.js` (`consume(e)`).
2. Input raw $(x, y, p, t)$ passes through `OneEuro` temporal low-pass filter (`ink.js`).
3. Filtered point is pushed to active wet stroke `state.cur` (`app.js`).
4. Real-time wet stroke is rendered to `#wet` canvas (`wctx`).
5. On `pointerup`, stroke is committed to `state.strokes` array, converted to centripetal Catmull-Rom Bezier cubics (`openPolylineToCubics` in `ink.js`), and rendered to dry canvas (`dctx`).
6. Stroke is written to binary WAL (`inkwell-wal`) for instant crash recovery.

---

## 📁 Exact File Map (Files to Point Codex To)

When prompting Codex, reference only these files depending on the task:

| Subsystem | Exact File Paths |
|---|---|
| **PDF Rasterization & Tiles** | `inkwell-app/src-tauri/src/commands.rs`<br>`inkwell/crates/inkwell-pdf/src/lib.rs`<br>`inkwell-app/src/js/app.js` |
| **Ink Curve Smoothing & Pen Feel** | `inkwell-app/src/js/ink.js`<br>`inkwell-app/src/js/app.js`<br>`inkwell/crates/inkwell-core/src/ink.rs` |
| **Build & Test Commands** | `inkwell-app/src-tauri/Cargo.toml`<br>`Launch Inkwell.bat` |

---

## 🎯 Task 1: Fix PDF Background Rasterization (Tile Rendering)

### Step 1.1: Debug PDFium & Tile IPC (Backend)
**Files to give Codex**:
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell/crates/inkwell-pdf/src/lib.rs`

**Copy-Paste Prompt for Codex**:
```text
Goal: Fix PDFium background tile rendering in inkwell-app.
Files:
1. inkwell-app/src-tauri/src/commands.rs
2. inkwell/crates/inkwell-pdf/src/lib.rs

Context:
When opening a PDF, state.pdf_bytes and state.page_infos are set, but render_tile IPC command returns null or empty bytes, leaving the canvas background blank white without PDF page content.

Instructions:
1. In commands.rs render_tile(), log any PDFium initialization or rendering error via eprintln! or return a clear Err(String) instead of swallowing errors.
2. In lib.rs init_pdfium(), ensure pdfium.dll is loaded using std::env::current_exe() parent path, current working directory, or system DLL paths.
3. Verify render_tile returns valid RGB byte slice of size px * px * 3 for the requested page and bounding rect. Do NOT modify any frontend files yet.
```

---

### Step 1.2: Blit PDF Tiles onto Canvas (Frontend)
**Files to give Codex**:
- `inkwell-app/src/js/app.js`
- `inkwell-app/src/index.html`

**Copy-Paste Prompt for Codex**:
```text
Goal: Fix frontend PDF tile blitting in app.js.
Files:
1. inkwell-app/src/js/app.js
2. inkwell-app/src/index.html

Context:
render_tile returns raw RGB bytes (px * px * 3). app.js fetchTile() converts this to ImageData and draws to tctx. However, drawPageBackground() or clearRect in redrawTiles() overwrites the tile.

Instructions:
1. In app.js redrawTiles(), call drawPageBackground() first to draw the white paper rect with shadow and red border.
2. Then call fetchTile() for the visible page rect, convert raw RGB to ImageData (setting alpha=255), and draw it with tctx.drawImage() or tctx.putImageData() at the exact screen coordinates of the page.
3. Ensure window.__TAURI__.core.invoke is correctly called in fetchTile(). Keep edits minimal and modular.
```

---

## 🎯 Task 2: Real-Time Ink Curve Smoothing & Fine Pen Feel

### Step 2.1: Streamline Trailing Spring Filter (Input Smoothing)
**Files to give Codex**:
- `inkwell-app/src/js/ink.js`
- `inkwell-app/src/js/app.js`

**Copy-Paste Prompt for Codex**:
```text
Goal: Add Streamline trailing-spring smoothing to pointer inputs in ink.js and app.js.
Files:
1. inkwell-app/src/js/ink.js
2. inkwell-app/src/js/app.js

Context:
Raw digitizer input points have high-frequency micro-jitter. We need a trailing spring filter (like Excalidraw / GoodNotes streamline) to absorb hand tremors while writing.

Instructions:
1. In ink.js, add a Streamline filter function or class:
   - Keeps current smoothed position (curX, curY, curP).
   - On incoming pointer point (rawX, rawY, rawP), updates:
     curX += (rawX - curX) * 0.45;
     curY += (rawY - curY) * 0.45;
     curP += (rawP - curP) * 0.35;
2. In app.js consume(e), pass incoming pointer events through this Streamline filter before pushing points to state.cur.
3. Set default pen baseWidth in app.js to 1.4 or 1.6 for fine, crisp line weight. Do NOT change committed stroke rendering yet.
```

---

### Step 2.2: Chaikin Corner-Cutting Subdivision & Quadratic Bezier Ribbon Rendering
**Files to give Codex**:
- `inkwell-app/src/js/ink.js`

**Copy-Paste Prompt for Codex**:
```text
Goal: Implement Chaikin subdivision and quadratic Bezier curves in ink.js for C1 continuous stroke rendering.
Files:
1. inkwell-app/src/js/ink.js

Context:
Drawing straight polylines between points creates angular corners. We need Chaikin corner-cutting subdivision + quadratic Bezier midpoint rendering.

Instructions:
1. In ink.js, implement chaikinSubdivide(points, iterations=2):
   - For each segment (A, B), generate points Q = 0.75*A + 0.25*B and R = 0.25*A + 0.75*B.
2. In drawStroke(ctx, stroke):
   - Subdivide stroke points using chaikinSubdivide().
   - Render the smooth curve using quadratic Bezier curves through segment midpoints: ctx.quadraticCurveTo(P_i.x, P_i.y, M_i.x, M_i.y) where M_i = (P_i + P_{i+1})/2.
3. Ensure pressure width interpolation remains smooth along the curve. Keep the code compact and clean.
```

---

## 🛠️ Verification Commands for Codex

Tell Codex to run these exact commands after each step to verify that nothing is broken:

```bash
# 1. Check Rust compilation:
cd inkwell-app/src-tauri
cargo build

# 2. Run backend tests:
cd ../../inkwell
cargo test --workspace

# 3. Test launcher:
.\Launch Inkwell.bat
```
