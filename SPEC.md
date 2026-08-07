# PDF-Native Ink Annotator — Technical Specification

> Working title: **Inkwell** (rename as you like)
> Target hardware: Huion H640P (8192 pressure levels, 233 PPS, **no tilt**, 6 express keys, indirect/screenless tablet)
> Primary platform: Windows laptop. Secondary: Linux, macOS. Later: Android/iOS (view + light edit).

This document is the source of truth for the project. It is written to be fed to a coding
agent as persistent context. Do not deviate from the **Non-Negotiables** without updating
this file first.

---

## 0. Non-Negotiables

| # | Rule | Why |
|---|---|---|
| N1 | **The saved file is always a valid, standard PDF.** No proprietary container, ever. | Portability, sync, longevity |
| N2 | **Pen input is processed on a dedicated thread** that never touches PDF decoding, layout, or disk I/O. | Latency |
| N3 | **The PDF underlay is never rasterized at import.** It is re-rendered per zoom level, on demand. | Crispness |
| N4 | **Ink is vector, always.** No pixel eraser, no bitmap ink layers. | Zoom, file size, editability |
| N5 | **Every user-facing action is a named Command with a stable ID.** Keybindings are data, not code. | Customizable shortcuts |
| N6 | Autosave must be crash-safe and must not re-upload the whole file to cloud sync on every tick. | Data safety + sync sanity |

---

## 1. The File Format Problem (the most important section)

### 1.1 The core insight

A PDF can carry three things at once:

1. **A visual layer** every PDF reader in the world understands.
2. **A semantic layer** other annotators understand (standard `/Annot` objects).
3. **A private layer** that only this app understands, which other readers silently ignore.

This is exactly how Apple's PDFKit stores Apple Pencil ink: custom dictionaries for the
stroke data + an appearance stream for the visual. We do the same, but documented and open.

### 1.2 Layer 1 — Visual (universal)

Every ink stroke is written into the page as a **filled vector path**, not a stroked line.

Why filled and not stroked: PDF's stroke operator (`S`) has a single constant line width.
Pressure-varying width is impossible with it. Instead we compute the **outline polygon** of
the variable-width stroke (offset curves on both sides of the centreline, distance = f(pressure)),
close it with round caps, and emit it as a fill (`f`) with cubic Béziers.

Result: resolution-independent, crisp at 6400% zoom, prints correctly, opens in Chrome,
Acrobat, Preview, any Android reader. This alone satisfies requirements 4, 5, 7, 10.

```
% pseudo content stream for one pressure stroke
q
  0.1 0.1 0.1 rg          % colour
  /GS_normal gs           % ExtGState (opacity, blend mode for highlighter)
  120.5 300.2 m
  ... c ... c ... c       % right-hand offset curve
  ... c ... c ... c       % left-hand offset curve, reversed
  h f
Q
```

### 1.3 Layer 2 — Semantic (interoperable)

Each stroke (or each stroke *group*, see below) is additionally registered as an `/Annot`
of `/Subtype /Ink`:

- `/InkList` — the centreline points, so Acrobat/Okular/Xodo can see and delete it.
- `/AP /N` — a Form XObject containing the **Layer 1** vector fill. Readers honour `/AP`
  over `/InkList`, so it looks identical to our own rendering.
- `/Rect` — tight bbox.
- `/NM` — a stable UUID (this is our stroke ID; it survives round-trips through other apps).
- `/M` — modification timestamp.

**Batching rule:** one `/Annot` per stroke is correct but explodes the annotation count on a
dense page (2000+ annots = slow in Acrobat). Batch strokes into groups of ~64 sharing one
tool/colour, or make it a user setting: `interop_granularity = stroke | group | page`.
Default `group`.

### 1.4 Layer 3 — Private (lossless editing)

Everything Layer 1 and 2 cannot express:

- Raw sample stream per stroke: `(x, y, pressure, t)` — quantised deltas
- Tool identity, brush parameters, smoothing settings
- Layers, groups, z-order
- **Infinite-canvas true coordinates** (see §3)
- Selection groups, text objects, links, page-scoped metadata
- Op-log for merge/sync (see §5)

Stored as **zstd-compressed CBOR** in an embedded file stream:

```
/Root
  /Names /EmbeddedFiles <name tree>
     "inkwell.doc" -> /Filespec { /EF { /F <stream> } /Desc "Inkwell editable data v1" }
  /Inkw_Doc  <indirect ref to same stream>     % fast path, avoids name-tree walk
  /Inkw_Ver  1
  /Inkw_Hash <hex sha256 of the visual layer we last wrote>
```

Private keys use the `Inkw_` prefix per PDF's second-class-name convention. Conforming
readers must ignore unknown keys — this is guaranteed by ISO 32000.

**Size:** quantise x/y to 1/100 pt as varint deltas, pressure to 1 byte. ~4 bytes/sample.
A densely handwritten A4 page ≈ 40–80k samples ≈ 300 KB raw ≈ **30–60 KB zstd**. Negligible.

### 1.5 Degradation contract

| Scenario | Behaviour |
|---|---|
| Opened in any PDF reader | Perfect visual fidelity. Annotations visible/deletable. |
| Edited + saved by Acrobat | Visual survives. `/Inkw_Doc` **may** survive (usually does; Acrobat preserves embedded files and unknown catalog keys). |
| Sidecar lost or hash mismatch | App detects it, warns, and **falls back to reconstructing strokes from `/InkList` + `/AP`** at constant width. Lossy but still editable. Never a hard failure. |
| File opened by an older version of this app | Version-gated: refuse to save if `Inkw_Ver` > known, offer read-only. |

### 1.6 Saving mechanics

Two modes, both required:

**A. Incremental append (autosave).** PDF supports appending changed objects + a new xref
section + a trailer whose `/Prev` points at the old xref. This is:
- fast (writes only deltas, no full rewrite)
- crash-safe by construction — a torn tail leaves the *previous* xref intact and valid
- free version history (each generation is a recoverable snapshot)

**B. Full linearised rewrite (explicit save / close).** Compacts, drops orphaned objects,
resets bloat. Trigger automatically when `file_size / logical_size > 1.6`.

**Write atomicity:** never write in place. Write to `name.pdf.tmp` in the same directory,
`fsync`, then atomic rename over the original. For incremental appends, append then `fsync`
then update length. Never hold an exclusive lock (breaks cloud sync clients).

---

## 2. Latency Architecture

### 2.1 Budget

Target **≤ 25 ms** pen-tip-to-photon on a 60 Hz laptop panel. Stretch: ≤ 16 ms.

```
pen sample (233 Hz)      4.3 ms  ← hardware floor, unavoidable
USB + driver             2–5 ms
OS input queue           1–3 ms
app processing           <1 ms   ← YOUR JOB
render + present         1–4 ms  ← YOUR JOB
compositor               0–16 ms ← YOUR JOB (avoid extra buffering)
display scanout+response 8–14 ms ← hardware
```

**Important reframe:** the H640P is an *indirect* device (no screen under the pen). Research
on direct-touch says humans notice ~2–10 ms; for **indirect** pointing the perceptual
threshold is far more forgiving (~25–40 ms). So your OpenBoard complaint is very likely
**not raw latency** — it is one or more of:

- dropped/coalesced samples making curves look polygonal
- inconsistent frame pacing (stutter), which is far more noticeable than constant latency
- full-scene redraw per sample (Qt `QGraphicsView` does this)
- the OS cursor and the ink drifting apart

Fix those and it will feel smooth even at 30 ms. **Consistency beats absolute latency.**

### 2.2 Threading model

```
┌──────────────────┐
│ Input thread     │  WM_POINTER / evdev. Highest priority.
│                  │  Reads coalesced history, pushes to lock-free ring buffer.
│                  │  Allocates nothing. Never blocks.
└────────┬─────────┘
         │ SPSC ring buffer
┌────────▼─────────┐
│ Render thread    │  Owns GPU. Draws wet-ink overlay every vsync.
│                  │  Composites: [PDF tile cache] + [committed ink] + [wet stroke]
└────────┬─────────┘
         │
┌────────▼─────────┐   ┌──────────────────┐   ┌─────────────────┐
│ UI thread        │   │ PDF worker pool  │   │ IO thread       │
│ menus, panels    │   │ pdfium tile render│   │ autosave, WAL   │
└──────────────────┘   └──────────────────┘   └─────────────────┘
```

**The wet/dry split is the single biggest win.** While the pen is down, the in-progress
("wet") stroke lives in its own lightweight layer. You redraw only that layer. On pen-up,
the stroke is simplified, committed to the document, baked into the "dry" ink layer, and the
wet layer is cleared. Never re-tessellate the whole page mid-stroke.

### 2.3 Windows input specifics

```c
EnableMouseInPointer(TRUE);
// handle WM_POINTERDOWN / WM_POINTERUPDATE / WM_POINTERUP
GetPointerPenInfo(id, &pi);
GetPointerPenInfoHistory(id, &count, buf);  // ALL samples coalesced into this message
```

- `GetPointerPenInfoHistory` is mandatory. Without it you get one sample per WM message
  (≈60/s) and throw away 75% of the tablet's 233 Hz. **This is the #1 cause of "polygonal"
  looking strokes** in naive implementations.
- History is returned **newest-first** — reverse it.
- `POINTER_PEN_INFO.pressure` is normalised to **0–1024**, not 8192. Practically irrelevant
  (nobody perceives >256 levels), but if you truly want the full 8192 you must use the
  legacy **WinTab** API instead — which costs you prediction and coalescing. **Do not.**
  Use WM_POINTER, keep "Windows Ink" *enabled* in the Huion driver.
- Disable press-and-hold gesture recognition on your window — it inserts a deliberate delay:
  set `TABLET_DISABLE_PRESSANDHOLD | TABLET_DISABLE_FLICKS` via the `MicrosoftTabletPenServiceProperty`
  window prop, or call `SetGestureConfig` to reject everything.
- Swapchain: `DXGI_SWAP_EFFECT_FLIP_DISCARD` + `DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT`
  + `SetMaximumFrameLatency(1)`, and wait on the waitable object each frame. Cuts up to one
  full frame of buffering.

Linux equivalent: libinput tablet-tool events via Wayland `zwp_tablet_v2`. X11 is a
latency/palm-rejection swamp — target Wayland.

### 2.4 Prediction (optional, do last)

One-Euro filter for smoothing + a 1–2 sample linear/quadratic extrapolation to visually
cancel ~8 ms. Only render prediction in the wet layer, never commit it. Overshoot on fast
direction changes looks worse than latency — make it toggleable and default it **off** until
you've measured.

### 2.5 How to actually measure latency

Do not guess. Film your screen and pen tip together with a phone at **240 fps** (4.17 ms per
frame). Count frames between the pen tip moving and the ink moving. This is the standard
technique and it's the only honest number. **Build this measurement into Milestone 0.**

---

## 3. Document Model & Infinite Canvas

```
Document
 ├─ Sheet[]            // ordered
 │   ├─ kind: BoundedPage { source_pdf_page: usize } | FreeCanvas
 │   ├─ transform      // sheet -> world
 │   ├─ Layer[]
 │   │   └─ Object[]   // Stroke | Image | TextBox | Shape
 │   └─ bbox_hint
 └─ Viewport[]         // N independent views onto the doc (see §4)
```

- All geometry is `f64` in PDF points, sheet-local.
- `FreeCanvas` sheets are unbounded. Strokes may live at any coordinate.

**Materialising infinity into a PDF (requirement 6 vs requirement 4):**

On save, each `FreeCanvas` sheet is converted to one or more real PDF pages:

1. Compute content bbox + margin.
2. Snap to the user's chosen page size grid (A4 / Letter / "fit content").
3. If content exceeds one page, **tile** it into a grid of pages, in reading order,
   with a small overlap and printed tile coordinates in the corner.
4. Write the *true* unbounded coordinates + tiling parameters into the private sidecar so
   reopening restores the exact infinite canvas.

Do **not** rely on PDF's `/UserUnit` to make giant pages. The base limit is 200×200 inches;
`/UserUnit` can push it to 75,000 inches but **most readers ignore `/UserUnit`**, which
silently breaks requirement 5. Tiling is portable; UserUnit is not.

Infinite canvas is requirement #6 and marked *optional*. **Cut it from v1.** Ship
"append a blank page" first, which covers 90% of the actual study workflow.

---

## 4. Multi-Viewport / Split View

A `Viewport` is `{ sheet_id, pan: Vec2, zoom: f64, rect_on_screen }`. The window holds N of
them in a splitter. They share one document model; each has its own zoom and scroll.

The user's stated workflow — **left: imported PDF page, zoomed in. right: a blank page I
inserted, at a different zoom, where I write notes** — is exactly two viewports with
independent state. This is cheap to build if viewports are first-class from day one, and
painful to retrofit. **Design it in from the start even if v0 only shows one.**

Killer feature for an *indirect* tablet, and nobody else does it:

> **Pane-locked tablet mapping.** The 6.3×3.9" H640P mapped to a 15" screen gives poor
> precision. Add a mode where the tablet's active area maps only to the **focused pane**,
> and remaps instantly when focus changes. Implement by intercepting absolute coordinates
> and rescaling them into the focused viewport rect. Bind to a hotkey.

---

## 5. Sync (requirement 5)

**v1: plain files in a Drive / OneDrive / Syncthing folder. No custom backend. No accounts.**

Rules to not corrupt files under a sync client:

- Atomic writes only (temp + rename), or append-only incremental updates.
- No exclusive locks, no lockfiles left behind.
- Watch the file's mtime/size while open; on external change, do **not** silently overwrite.
  Show a bar: `This file changed on disk. [Reload] [Keep mine] [Save a copy]`.
- **Do not autosave the PDF every 10 seconds.** Google Drive re-uploads the entire file on
  every change; a 40 MB PDF re-uploaded 360 times an hour is user-hostile.

**Autosave design that solves this:**

```
notes.pdf              ← the real document, written on idle / explicit save
.notes.pdf.wal         ← append-only journal of operations since last PDF write
```

- Every committed stroke appends an op to the WAL (a few hundred bytes, instant, fsync'd).
- The PDF is rewritten when: 20 s of pen inactivity, OR window loses focus, OR 3 min elapsed,
  OR user hits Ctrl+S, OR app closes.
- On crash, startup finds a non-empty WAL and replays it. Zero data loss, zero sync thrash.
- Put the WAL in a local temp dir keyed by file hash, **not** next to the PDF (keeps the
  sync folder clean).

**Design for merge now, ship it later.** Because every object has a UUID and every change is
an op in the log, a genuine multi-device merge is tractable: strokes are immutable and
append-only, deletions are tombstones, so merging two divergent files is `union(strokes) −
union(tombstones)` with a Lamport clock for ordering. That is a **real CRDT** and it's
unusually easy in this domain. No existing FOSS notes app does this properly. If you want
one feature that makes the project worth existing, this is it.

---

## 6. PDF Rendering (requirement 7)

**Library: PDFium** (BSD-3-Clause). Reasons:
- Permissive licence → your app can be MIT/MPL and still ship on the iOS App Store later.
- Battle-tested (it's Chrome's PDF engine).
- Rust binding: `pdfium-render`. C++: link directly.

Licence trap to avoid: **MuPDF is AGPL**, **Poppler is GPL**. Both are fine for a FOSS
desktop app, but AGPL/GPL is **incompatible with the Apple App Store**, killing your
future iPad story. Since sync-to-tablet is requirement #5, take PDFium.

**Never rasterise at import.** (This is precisely the bug that ruins Notes 3 for you.)

Tile cache:
- 512×512 device-pixel tiles, rendered at `zoom × devicePixelRatio`, snapped to LOD steps
  (¼, ½, 1, 2, 4, 8×) so you cache-hit while pinch-zooming.
- Background thread pool renders tiles; the render thread immediately draws the nearest
  available coarser LOD upscaled, then swaps in the sharp tile when ready.
- LRU eviction with a hard budget (e.g. 256 MB).
- **Never** block the render thread or the input thread on tile render.
- Cancel in-flight tile jobs when the viewport moves past them.
- Text stays vector in PDFium's output at high zoom — this is what makes it "crisp" and
  fixes your complaint.

Also expose PDFium's text layer: text selection, copy, and search over the underlay are
nearly free once you have it, and are a big quality-of-life win for studying.

---

## 7. Ink Pipeline

```
raw samples (x, y, p, t)
  → dedup + reject (p==0, first-sample pressure spike, duplicate coords)
  → One-Euro filter on x,y  (cutoff tuned per speed)
  → EMA on pressure (α≈0.3) + user-configurable response curve (gamma / spline)
  → width = base_width × curve(p)     [H640P has NO tilt — do not build tilt brushes]
  → wet render: per-segment quads with round joins, or SDF capsules
  → on pen-up: fit cubic Béziers (Schneider fit, tolerance ~0.3pt)
  → simplify (pressure-aware RDP)
  → generate outline polygon for PDF export
  → commit to layer, push undo op, append WAL
```

Notes:
- The first 1–2 samples of a stroke on Huion tablets frequently report garbage pressure.
  Discard or backfill from sample 3.
- Store the **filtered** samples, not raw. You never need raw again, and it halves file size.
- Highlighter = same pipeline, `/GS` with `/BM /Multiply` and `/CA 0.4`. In PDF this is a
  standard blend mode; it renders identically everywhere.

### Tool set (requirement 9)

**v1:** pen, highlighter, **stroke eraser** (deletes whole strokes) + **area eraser**
(splits strokes at intersection — harder, do second), lasso select (move/scale/rotate/
recolour/delete/copy), straight-line/ruler, rectangle/ellipse/arrow with "draw-then-snap"
recognition, text box, image paste, laser pointer (ephemeral, non-persisted).

**Never build a pixel eraser.** It forces a raster ink layer and destroys N4, N3, and file size.

---

## 8. Commands & Keybindings (requirement 3)

Every action is:

```rust
Command { id: "tool.eraser.stroke", title: "Stroke Eraser", category: "Tools",
          when: "editorFocused", run: fn(&mut App) }
```

Keymap lives in `keymap.toml` next to the config, hot-reloaded on change:

```toml
[[bind]]
key = "e"                 # chords supported: "ctrl+k ctrl+s"
command = "tool.eraser.stroke"
when = "editorFocused"

[[bind]]
key = "e"
command = "tool.eraser.stroke"
mode = "spring"           # hold-to-activate, releases back to previous tool
```

Requirements:
- **Spring-loaded modifiers** (hold key = temporary tool, release = revert). This is the
  single biggest speed win in any ink app and almost nobody implements it.
- **Command palette** (Ctrl+Shift+P) listing every command — it's free once commands are data,
  and it makes the app discoverable without menus.
- Pen barrel button + eraser end are bindable like keys.
- The H640P's 6 express keys are configured in the Huion driver and arrive as normal
  keystrokes. **Nothing special to implement** — just don't hardcode anything to F13–F18 etc.
- Ship a `keymap.default.toml` and let the user's file override entry-by-entry, not
  wholesale-replace.

---

## 9. Technology Stack Decision

| Stack | Latency | Dev speed w/ AI | Cross-platform | Mobile path | Verdict |
|---|---|---|---|---|---|
| **Rust + winit + wgpu + pdfium-render** | Best | Good | Win/Mac/Linux | Hard | **Best end state** |
| **C++ + Qt6 Quick (RHI) + PDFium** | Best | Best (huge training corpus) | Win/Mac/Linux | Poor | Strong, but C++ footguns |
| **Tauri v2 + WebGPU canvas + PDFium in Rust core** | Good enough | Best | Everything incl. iOS/Android | Excellent | **Best risk-adjusted** |
| Electron | Mediocre | Best | Desktop | No | No — heavy, violates "lightweight" |
| Flutter | Mediocre | OK | Everything | Good | Desktop pen support is still patchy |

**Recommendation: Tauri v2.**

- Rust core owns PDFium, the document model, the file format, and the WAL. All the hard,
  correctness-critical logic is in a real systems language and is unit-testable headlessly.
- The UI/canvas is web tech, where an AI agent is dramatically more productive.
- Pen input in the webview: `pointerdown/move/up` + **`event.getCoalescedEvents()`** (this is
  the web equivalent of `GetPointerPenInfoHistory` — mandatory) + `event.pressure`.
- Render the wet stroke on a dedicated `<canvas>` layered above everything with
  `will-change: transform` so it never triggers reflow.
- **The honest cost:** WebView2 adds roughly one composited frame (~8–16 ms) versus native.
  Given the H640P is an indirect device, this is very likely acceptable. **Prove it in
  Milestone 0 before committing.**
- Tauri v2 ships iOS/Android targets, which is the only realistic path to requirement 5's
  "edit on my phone" endgame with a solo developer.

**If Milestone 0 shows the webview feel is unacceptable to you:** fall back to
Rust + winit + wgpu, keep the entire core crate unchanged, and swap only the shell. Structure
the repo so that is a real option:

```
crates/
  inkwell-core/     # doc model, ink math, undo, commands   (no UI, no I/O)
  inkwell-pdf/      # pdfium wrapper, read + write + incremental save
  inkwell-io/       # WAL, autosave, file watching, conflict detection
  inkwell-shell-tauri/
  inkwell-shell-native/   # empty for now — the escape hatch
```

---

## 10. Milestones

**M0 — The Latency Spike (1–2 weeks). Gate: do not proceed if this fails.**
Blank window. Pen draws a pressure-varying vector stroke. Nothing else — no PDF, no save,
no UI chrome. Then film it at 240 fps and write the measured latency in the README.
Target ≤ 25 ms and visually smooth curves at fast scribble speed.
*If you can't make an empty window feel good, no amount of features will save it.*

**M1 — Viewer.** PDFium tile-rendered PDF, pan/zoom, tile cache, LOD. Verify text is crisp
at 800% zoom.

**M2 — Annotate + Save.** Ink on top of the PDF. Write Layer 1 + Layer 2 + Layer 3. Reopen
losslessly. Open the output in Chrome and Acrobat and confirm it looks identical.

**M3 — Survival.** WAL, autosave-on-idle, crash recovery, external-change detection, undo/redo.

**M4 — Tools.** Erasers, lasso, shapes, highlighter, colours, text boxes.

**M5 — Workflow.** Split viewports, insert blank page, page thumbnails/reorder, pane-locked
tablet mapping.

**M6 — Shortcuts.** Command palette, keymap.toml, spring-loaded tools.

**M7 — Optional.** Infinite canvas, then the CRDT merge.

---

## 11. Testing

- **Golden-file tests:** for a fixed input stroke set, snapshot the generated PDF content
  stream. Catches format regressions.
- **Round-trip property test:** `open(save(doc)) == doc` for randomly generated documents.
- **Third-party validation:** run output through `qpdf --check` and `veraPDF` in CI.
- **Cross-reader screenshot diff:** render output with pdfium, Ghostscript, and MuPDF; diff
  the images. Catches "looks right in my app only".
- **Latency regression:** a synthetic input injector that replays a recorded stroke and logs
  input-timestamp → present-timestamp deltas. Fail CI if p99 regresses.
- **Sync torture test:** kill -9 the process mid-write, 200 times, in a loop. The file must
  always open.

---

## 12. Prior Art — read these before writing code

| Project | Take from it | Its weakness |
|---|---|---|
| **Stylus Labs Write** (AGPL, C++/SDL, github.com/styluslabs/Write) | Best-in-class low-latency ink loop; **SVG as the native format**; split view; iOS+Android+desktop from one codebase | Weak PDF support (converts PDF→SVG externally); AGPL |
| **Xournal++** (GPL, C++/GTK) | Mature tool set, LaTeX, plugin API, PDF annotation UX | `.xopp` sidecar references the PDF by path → breaks sync; exported PDF is not re-editable (see issue #4666) |
| **Rnote** (GPL, Rust/GTK4) | Infinite canvas done well, clean Rust ink pipeline, autosave | `.rnote` is gzipped JSON and **explicitly unstable across versions**; no PDF round-trip |
| **PDFium** | Just use it | — |
| **Apple PDFKit** | Proof the Layer1+2+3 design works at scale in shipping software | Closed |
| **PDF Association issue #548** | Ongoing (stalled) effort to standardise pressure ink in PDF. Align your private format with it so you can migrate later. | Not a standard yet |

---

## 13. Explicit Non-Goals for v1

- Handwriting recognition / OCR
- Real-time collaboration
- Cloud accounts or a custom backend
- Audio recording
- Pixel/raster brushes, textures, tilt
- Windows 7/8 support
- Plugin system
