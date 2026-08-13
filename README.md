# Inkwell — PDF-Native Vector Ink Annotator

![Inkwell Banner](inkwell-m0/screenshot.png)

> [!CAUTION]
> **WORK IN PROGRESS**: Inkwell is an experimental digital handwriting and PDF annotation desktop workstation under active development. Core functionalities—including real-time vector outline ribbons, LOD tile caching, PDFium vector rasterization, and append-only incremental PDF saving—are continuously being enhanced.

**Inkwell** is a high-performance, low-latency digital handwriting and PDF annotation desktop application engineered for tablet digitizers (e.g. Wacom, Huion, Microsoft Surface, iPad via Apple Pencil, and high-refresh touchscreens). Built with **Rust**, **PDFium**, and **Tauri v2**, Inkwell combines zero-latency stroke response with standard vector PDF `/Ink` interoperability.

---

## Key Features

### 🖋️ Hardware-Accelerated Vector Ink Engine
- **Low-Latency Dual-Canvas Architecture**: Separate wet (active stroke) and dry (committed vector ink) layers running at native digitizer polling rates (up to 240Hz+).
- **Sub-Pixel Pressure Sensing**: 10-bit analogue pressure resolution with customizable stroke width taper, gamma curves, and One-Euro noise filtering.
- **Vector Ribbon Outlines**: Generates smooth cubic Bézier outline ribbons with true $C^1$ continuity, avoiding faceting or degradation at high zoom levels.

### 📄 Native PDF Integration & Durability
- **PDFium High-Resolution Rasterizer**: High-fidelity vector tile rendering on-demand per LOD level for complex PDFs, textbooks, and multi-page documents.
- **Append-Only Incremental Save**: Original PDF bytes are never overwritten or corrupted in-place. Annotations are appended as standard ISO 32000 vector streams.
- **WAL Journal Crash Durability**: Write-Ahead Logging (`inkwell-wal`) records every stroke and erasure immediately with fsync, seamlessly restoring unsaved state upon recovery.
- **Backend Security Hardening**: Input path sanitization, bounds-clamped tile dimensions, and memory safety guarantees across all Tauri IPC commands.

### 🎨 Modern Workspace & Navigation
- **3-Column Glassmorphic Layout**: Pinned left navigation rail (`#navRail`), slide-out secondary drawer (`#navDrawer`), and main viewport stage (`#stage`).
- **Page Navigation Suite**: Top header navigation cluster with 1-click previous/next buttons (`◀` / `▶`), page count (`Page X / Y`), insert page button (`+`), and dual-pane split controls.
- **On-Canvas Floating Edge Flippers**: Subtle translucent edge chevrons for rapid 1-click page flipping while reading and annotating.
- **Redesigned Secondary Drawers**:
  - **Outline / TOC**: Document chapter hierarchy with custom bookmark fallback.
  - **Full-Text Search**: In-document keyword search with highlighted snippets and match counts.
  - **Bookmarks**: Timestamped custom page bookmarks with 1-click navigation and deletion.
  - **Layers**: Real-time vector stroke counter and independent ink layer visibility toggles.
  - **Settings & Calibration**: Hardware pointer coalescing toggle, stroke width slider with value badges, and preset color swatches.
- **Floating Zoom & Inking Docks**: Frosted acrylic glass docks with SVG vector icons (Zoom In/Out, Fit to Window, Dual Pane, Fullscreen, and Tools).
- **Multi-Document Tabs**: Tab strip supporting simultaneous document switching and independent viewport states.
- **Command Palette & Radial Menu**: Quick command execution (`Ctrl+Shift+P`), 6-slot stylus radial menu, and lasso selection with stroke deletion.

---

## Technology Stack

- **Core Engine**: Rust (`inkwell-core`, `inkwell-pdf`, `inkwell-wal`)
- **Desktop Shell**: Tauri 2.0 (Windows / macOS / Linux)
- **PDF Rendering**: PDFium (`pdfium-render` bindings)
- **Frontend Layer**: HTML5 Canvas, Vanilla CSS (Glassmorphism design system), JavaScript ESNext
- **Testing & QA**: PyMuPDF, Poppler, PyPDF, Playwright CDP Synthetic Pen testing

---

## Project Structure

```
InkWell/
├── inkwell/                      # Core Rust workspace
│   ├── crates/inkwell-core/      # Document model, vector geometry, RDP simplification
│   ├── crates/inkwell-pdf/       # PDFium tile rasterization & PDF structure manipulation
│   └── crates/inkwell-wal/       # Binary Write-Ahead Log engine
├── inkwell-app/                  # Tauri 2.0 Desktop Application
│   ├── src-tauri/                # Tauri backend IPC commands & Rust main entry point
│   └── src/                      # Canvas frontend, UI styling, and ink rendering
├── inkwell-m0/                   # Playwright smoke test harness & synthetic pen capture
├── tools/                        # Validation scripts (validate.py, PDF spec checks)
└── Launch Inkwell.bat            # Desktop launcher script for Windows
```

---

## Quick Start

### Prerequisites
1. **Rust Toolchain**: `rustc` and `cargo` (1.75+)
2. **Node.js**: `node` (v18+) and `npm`
3. **PDFium**: `pdfium.dll` (placed in `bin/` or system PATH)

### Running Locally
```bash
# Using the Windows batch launcher:
.\Launch Inkwell.bat

# Or building via Cargo:
cd inkwell-app/src-tauri
cargo build
.\target\debug\inkwell-app.exe
```

---

## Testing & Quality Assurance

Inkwell features a comprehensive verification suite spanning unit tests, PDF standards compliance, and synthetic pen input simulation:

```bash
# 1. Run core Rust unit and integration tests (46 tests)
cd inkwell
cargo test --workspace

# 2. Run PDFium live tile rendering tests
cargo test --package inkwell-pdf

# 3. Run cross-language PDF standards validator (PyPDF, Poppler, MuPDF)
py -3 tools/validate.py

# 4. Run synthetic pen CDP input smoke test (18/18 checks)
cd ../inkwell-m0
py -3 test_smoke.py
```

---

## Keyboard & Stylus Shortcuts

| Action | Shortcut |
|---|---|
| **Previous Page** | `Left Arrow` / `PageUp` / `[` |
| **Next Page** | `Right Arrow` / `PageDown` / `]` |
| **First / Last Page** | `Home` / `End` |
| **Thumbnails / Page Jump** | `Ctrl` + `G` |
| **Search Document** | `Ctrl` + `F` |
| **Open PDF** | `Ctrl` + `O` |
| **Save Document** | `Ctrl` + `S` |
| **Toggle Sidebar Drawer** | `Ctrl` + `B` |
| **Command Palette** | `Ctrl` + `Shift` + `P` |
| **Undo / Redo** | `Ctrl` + `Z` / `Ctrl` + `Y` |
| **Pen Tool** | `P` |
| **Highlighter** | `H` |
| **Eraser (Spring-Loaded)** | Hold `E` |
| **Laser Pointer (Spring-Loaded)** | Hold `L` |
| **Lasso Select** | `V` |
| **Ruler / Rectangle / Ellipse** | `R` / `Q` / `O` |
| **Radial Quick Menu** | Stylus Barrel Button / Right Click |

---

## License

Dual-licensed under MIT / Apache 2.0. See [LICENSE](LICENSE) for details.
