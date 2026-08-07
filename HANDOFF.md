# HANDOFF.md — Inkwell

**Read this file completely before writing any code.**

You are continuing work on **Inkwell**: a free, open-source, PDF-native
pressure-sensitive annotation and note-taking app. Design work and two verified
milestones already exist. This document is the complete handoff: state, rules,
hard-won findings, and the exact next tasks with acceptance criteria.

Author of the prior work is not available. Do not assume access to any prior
conversation. Everything you need is in this repo.

---

## 1. What the project is, in one paragraph

A student with a **Huion H640P** graphics tablet wants to annotate lecture PDFs
and take handwritten notes on a Windows laptop. Every existing tool fails on at
least one axis. The gap nobody has filled is this: **annotated ink that lives
inside one ordinary PDF file, fully re-editable, with pressure preserved.**
Xournal++ stores a `.xopp` sidecar that references the PDF by absolute path
(breaks sync, breaks moving files, and the exported PDF is not re-editable).
Rnote's `.rnote` format is explicitly unstable across versions. Drawboard PDF
paywalls pressure. Notes-style apps rasterise PDFs at import so they pixelate
when you zoom. Inkwell's entire reason to exist is solving the file-format
problem properly; everything else is table stakes.

### The eleven original requirements

1. Smooth responsiveness, zero perceived lag, stable
2. Pressure sensitivity, free
3. Fully customisable keyboard shortcuts
4. **No proprietary file types — ideally everything in one PDF**
5. Trivial sync via a Drive/OneDrive folder
6. Infinite canvas (optional)
7. Excellent PDF support: crisp import, deep zoom, insert pages, split view
8. Free, open source, lightweight, fast
9. Rich tools: shapes, erasers, lasso select
10. Easy PDF export
11. Autosave

---

## 2. Current state

Two milestones are complete and verified. **One is not started and is the
critical path.**

| Milestone | What | State |
|---|---|---|
| Design | `SPEC.md` — full architecture | ✅ |
| **M0** | Latency spike: blank window, pressure ink, measurement HUD | ✅ built, **not yet run on the tablet** |
| **M1 core** | Document model, ink maths, PDF format, WAL, tile cache | ✅ 43 tests, 24 cross-language checks |
| **M1 rendering** | PDFium binding | ❌ **NOT STARTED — critical path** |
| M2+ | Shell wiring, tools, split view, shortcuts | ❌ |

### Repo layout after you assemble it

```
inkwell/                     <- from inkwell-core.tar.gz
  Cargo.toml                 workspace
  README.md                  core crate docs — read this second
  AGENTS.md                  rules for agents in this crate — obey it
  crates/inkwell-core/
    src/ink.rs               One-Euro filter, brush, StrokeBuilder, RDP, ribbon geometry
    src/codec.rs             varint-delta stroke encoding
    src/doc.rs               Document / Sheet / Layer / Viewport, sidecar container
    src/pdfobj.rs            shallow byte-level PDF reader (classic xref ONLY)
    src/pdf.rs               three-layer incremental writer + crash recovery
    src/tiles.rs             LOD tile cache (trait-based rasteriser, no PDFium yet)
    src/wal.rs               write-ahead log, flush policy, atomic writes
    tests/integration.rs     22 tests — format, WAL, recovery
    tests/tiles.rs           14 tests — LOD, eviction, fallback, cancellation
    tests/geometry.rs        6 tests  — outline accuracy, C1 continuity
    examples/annotate.rs     full pipeline CLI, used by the validator
  tools/make_fixture.py      generates fixtures/lecture.pdf
  tools/validate.py          cross-language validation
  tools/run_validation.sh    ONE COMMAND THAT MUST STAY GREEN
  fixtures/                  test PDF (generated)

inkwell-m0/                  <- from inkwell-m0.tar.gz (keep as a separate dir for now)
  README.md                  how to run the latency test — read before touching it
  AGENTS.md                  rules for the spike — obey it
  src/index.html             double-clickable, no build step
  src/styles.css
  src/ink.js                 One-Euro + ribbon renderer (JS twin of ink.rs)
  src/hud.js                 metrics, gate thresholds, diagnostics
  src/app.js                 pointer pipeline, wet/dry canvases
  src-tauri/                 Tauri v2 host, ~10 lines + WebView2 latency flags
  test_smoke.py             18 Playwright checks
```

### Verify the handoff before changing anything

```bash
cd inkwell
./tools/run_validation.sh        # expect: 43 Rust tests pass, 24/24 checks pass
cargo clippy --all-targets       # expect: 0 warnings
```

```bash
cd inkwell-m0
python3 test_smoke.py            # expect: 18/18 (needs playwright + chromium)
```

If either is not green, **stop and report it**. Do not build on a broken base.

---

## 3. The file format — the core idea

One standard PDF carries three layers simultaneously.

| Layer | Content | Who reads it | Loses |
|---|---|---|---|
| **1 visual** | variable-width ribbons as **filled** vector paths | every PDF reader in existence | nothing (vector) |
| **2 interop** | `/Ink` annotations with `/AP` appearance streams | Acrobat, Okular, Xodo, Preview | pressure |
| **3 data** | zlib sidecar embedded under private `/Inkw_*` keys | only Inkwell | nothing |

**Why filled paths, not strokes.** PDF's stroke operator (`S`) has exactly one
line width. Pressure is impossible with it. So we offset the centreline by the
pressure-derived half-width on both sides, close it with round caps, and fill it
(`f`). This is the decision that makes pressure survive into a file Chrome opens.

**Why a private layer.** Layers 1 and 2 cannot carry pressure, timestamps, tool
identity or layer structure. ISO 32000 guarantees conforming readers ignore
dictionary keys they don't recognise, so the editable data rides along
invisibly. Apple's PDFKit does exactly this for Apple Pencil ink.

**Graceful degradation.** `pdf::read_sidecar` returns `Ok` / `Absent` /
`Stale` / `Corrupt`. Losing the sidecar must never be a hard failure — fall back
to reconstructing strokes from `/InkList` at constant width.

**Saving = PDF incremental update.** Append changed objects, a new xref section,
and a trailer whose `/Prev` chains to the previous one. Consequences:
- Crash safety is *structural*: a torn tail leaves the previous xref valid.
  Recovery is `truncate to the last %%EOF` (`pdf::recover_truncated`).
- Every generation is a recoverable snapshot, so version history is free.

**The WAL exists for sync, not durability.** Google Drive re-uploads the whole
file on every change; autosaving a 40 MB PDF every 10 s is user-hostile. So each
committed stroke appends a few hundred fsynced bytes to a *local* journal, and
the PDF is rewritten only when the user pauses (`FlushPolicy`: 20 s idle, focus
loss, explicit save, close, or a 180 s ceiling). **Keep the journal out of the
synced folder** — use a temp dir keyed by a hash of the document path.

---

## 4. Findings you must not rediscover the hard way

These cost real time. All are pinned by tests now; do not "simplify" them away.

| Finding | Detail |
|---|---|
| **Duplicate private keys serve stale data** | Appending a 2nd generation left two `/Inkw_Doc` entries in the catalog. Readers take the **first**, so the app silently loaded generation 1's data while displaying generation 2. `dict_without` strips our own keys before rewriting. Pinned by `multiple_generations_do_not_duplicate_our_objects`. |
| **8-bit pressure discards real data** | Windows Ink delivers pressure at **10-bit** (0..1024). Storing a raw byte collapsed 746 distinct source levels to 229. Pressure is now a zigzag-varint *delta* at 10-bit — lossless w.r.t. the device, and near-free because consecutive samples barely differ. |
| **Smoothing the whole closed outline is catastrophic** | The outline has *intentional* sharp corners where a long edge meets a round cap. Catmull-Rom through them bulges every stroke end: error went 0.046 pt → **2.37 pt**, fifty times worse. Smooth **per edge**; leave caps as chords. |
| **Uniform parameterisation overshoots on uneven spacing** | RDP simplification deliberately produces uneven points. Uniform Catmull-Rom was only 1.7× better than a polyline. **Centripetal** knots + three-point one-sided end tangents got it to **0.0017 pt** (27× better than a polyline). |
| **`GetPointerPenInfoHistory` / `getCoalescedEvents()` is mandatory** | Without it you get ~1 sample per frame (~60 Hz) and throw away 75% of the H640P's 233 Hz. This is the #1 cause of "polygonal" looking strokes and is very likely what makes OpenBoard feel bad. |
| **Windows Ink must be ON in the Huion driver** | Counterintuitive vs. art-forum advice. WinTab gives the full 8192 pressure levels but costs you coalescing and prediction. Nobody perceives past ~256 levels. Take WM_POINTER's 1024. |
| **The H640P has NO tilt** | Do not build tilt-based brushes. 8192 pressure levels, 233 PPS, 6 express keys (which arrive as ordinary keystrokes — no special code needed). |
| **Indirect tablets are latency-forgiving** | No screen under the pen, so the perceptual threshold is ~25–40 ms, not ~2–10 ms. **Frame-pacing consistency matters far more than absolute latency.** Jitter is a gate for a reason. |
| **My test helpers were wrong twice** | A radial-error helper measured across *both* ribbon edges and reported an error of exactly the stroke width — looked like a catastrophic geometry bug, was a measurement bug. A pressure-fidelity assert used an absolute level count and failed because all synthetic strokes shared one identical envelope. **When a test fails, decide whether the test or the code is wrong before changing either.** |

### Measurements that must not regress

| Metric | Current | Test |
|---|---|---|
| Codec size | ~4.0 bytes/sample | `codec_size_is_about_four_bytes_per_sample` |
| Outline radial error | 0.0017 pt on a test circle | `bezier_outline_beats_a_polyline_on_a_known_circle` |
| Simplified-stroke outline error | 0.13 pt at RDP tol 0.4 | `faceting_does_not_return_when_the_stroke_is_simplified` |
| Pressure round-trip | ≥90% of source levels, >200 absolute | `sidecar_survives_the_pdf_round_trip` |
| Crash recovery | exact, at 8 tear offsets | `torn_write_recovers_to_the_previous_generation` + validator V5 |

---

## 5. Hard rules

Violating any of these silently breaks the project's reason to exist.

1. **The saved file is always a valid, standard PDF.** No proprietary container,
   no sidecar file next to the PDF, ever. If a feature seems to need one, say so
   and stop.
2. **Writes are append-only.** `PdfFile::finish` must always emit a buffer whose
   prefix is byte-identical to its input.
3. **Ink is a filled ribbon, never a stroked line.** Converting `ribbon_path` to
   `m`/`l`/`S` silently deletes pressure sensitivity.
4. **Never rasterise the PDF underlay at import.** Tiles, on demand, per LOD.
5. **Never do work in the pointer handler.** It runs up to 233×/second. No
   allocation in loops, no DOM access, no `getBoundingClientRect` per event, no
   logging, no layout. Cache on pointerdown.
6. **Never redraw the whole scene mid-stroke.** The wet/dry split is
   load-bearing. `#dry` / the committed layer is only fully redrawn on resize.
7. **Never strip a key you did not write.** Third-party annotations, form fields
   and metadata must survive untouched.
8. **Do not delete the `Error::XrefStream` check** to make a file "work". That
   would corrupt users' documents.
9. **`sync_data` in `Wal::append` is load-bearing.** Don't remove it for speed,
   don't batch appends. Flush the PDF *before* truncating the journal, never the
   reverse.
10. **Do not change gate thresholds or test tolerances to get green.** If one is
    genuinely wrong, say so and explain why.
11. **Never claim anything about latency or feel.** You have no pen, no display,
    no camera. Report what the code does; let the human report how it feels.
12. **No build step for `inkwell-m0/src`.** `index.html` must keep working when
    double-clicked from the filesystem, offline. This is a testing requirement.

### Definition of done for any change

- `inkwell/tools/run_validation.sh` fully green
- `cargo clippy --all-targets` reports zero warnings
- Every bug fix has a regression test **named after the bug**, not the function
- Anything touching the file format also passes `tools/validate.py` — Rust
  agreeing with Rust proves nothing about the bytes
- You state plainly which claims you verified and which you did not

---

## 6. Task queue

Do these in order. Do not start a later task to avoid a blocker in an earlier one.

### T0 — Run the M0 gate (HUMAN TASK, cannot be delegated)

The user must do this. Your job is only to not block it.

1. Extract `inkwell-m0`, double-click `src/index.html` in **Edge**.
2. Huion driver: **Windows Ink ON**, map to one monitor, disable pen filtering.
   Laptop plugged in, power plan High Performance.
3. Scribble hard ~20 s. Read the verdict and diagnostics.
4. Film screen + pen tip at **240 fps** (4.17 ms/frame), count frames between the
   tip changing direction and the ink changing direction. **Record the number in
   `inkwell-m0/README.md`.**

Gates: pointerType `pen` · ≥150 Hz sampling · evt→paint p95 ≤25 ms · frame
jitter σ ≤3.0 ms · ≥200 pressure levels.

**This decides the shell.** Pass → Tauri v2 (default plan). Fail → native
Rust + winit + wgpu. `inkwell-core` is unaffected either way, which is why it was
built first.

### T1 — PDFium integration (CRITICAL PATH) ⭐

Create a new crate `crates/inkwell-pdf`. Two jobs:

**T1a — Normalisation.** `pdfobj` handles classic cross-reference tables only.
Most real PDFs use xref streams with the catalog and page objects compressed
inside object streams, where byte-scanning cannot reach. **This means Inkwell
currently cannot annotate a typical downloaded lecture PDF.** Use PDFium to load
and re-save such documents into a classic-xref form on import, then hand the
bytes to `PdfFile::open`.

- Use **PDFium (BSD-3-Clause)**, crate `pdfium-render`. Prebuilt binaries:
  `pdfium-binaries` releases.
- **Do NOT use MuPDF (AGPL) or Poppler (GPL).** GPL/AGPL is incompatible with the
  Apple App Store, which would permanently foreclose the iPad story that
  requirement 5 depends on. This is not negotiable.
- Acceptance: a corpus of ≥10 real-world PDFs (arXiv papers, scanned notes,
  LaTeX output, Word exports, a Google Docs export) each import, annotate,
  save, reopen losslessly, and pass `tools/validate.py`. Add them as fixtures
  (or a download script if licensing is unclear).

**T1b — Rasteriser.** Implement `inkwell_core::tiles::PageRasterizer` over
PDFium. All the fiddly logic — LOD selection, visible set, LRU eviction under
budget, coarser-LOD fallback so zooming never flashes white, cancellation while
panning — already exists and is tested against a stub in `tests/tiles.rs`. This
should be a thin adapter.

- Acceptance: `tests/tiles.rs` passes unchanged with the PDFium impl swapped in
  for `Stub`. Add a visual test rendering a text-heavy page at LOD 0 and LOD 3
  and asserting the LOD-3 render has measurably more edge detail (e.g. higher
  gradient energy) — this is what proves "crisp when zoomed".
- Also expose PDFium's text layer. Text selection, copy and search over the
  underlay are nearly free once you have it and are a large study-workflow win.

### T2 — Wire the core to the shell

Give the user something they can draw in and save from.

- Rust side: `Document`, `PdfFile`, `Wal`, `TileCache` behind Tauri commands
  (or direct calls in the native shell).
- Frontend: replace the M0 blank canvas with tile-rendered PDF underneath the
  existing wet/dry ink layers. **Do not touch the pointer pipeline** — it is the
  one part that passed a latency gate.
- Port `src/ink.js`'s geometry to call into Rust, or keep the JS twin and add a
  test asserting both produce the same outline within 1e-6. **They must not
  silently diverge** — that is why the maths was written twice deliberately.
- Acceptance: open a PDF, annotate, kill the process (`taskkill /F`), reopen,
  and lose nothing beyond the last few seconds. Then put the file in a Drive
  folder and confirm the upload count is bounded by pauses, not by strokes.

### T3 — Tools (requirement 9)

Pen, highlighter (multiply blend, already supported in the writer), **stroke
eraser** then **area eraser** (splits strokes at intersection), lasso select
(move/scale/rotate/recolour/delete/copy), ruler/straight line, shapes with
draw-then-snap recognition, text box, image paste, laser pointer (ephemeral,
never persisted).

**Never build a pixel eraser.** It forces a raster ink layer and destroys the
vector guarantee, deep zoom, and file size all at once.

Undo: command stack with inverse ops, coalesced per stroke.

### T4 — Workflow (requirement 7)

- **Split viewports.** `Viewport { sheet, pan, zoom }` is already first-class in
  `doc.rs`. The user's stated workflow is: left pane = imported PDF page zoomed
  in, right pane = a blank page they inserted, at a different zoom, for notes.
  Two viewports over one document.
- Insert blank page, page thumbnails, reorder.
- **Pane-locked tablet mapping.** Map the H640P's 6.3×3.9" area to only the
  focused pane and remap on focus change. On an indirect tablet driving a 15"
  screen this is a large precision win and no other app has it.
- Warn when ink falls outside the page MediaBox (the example currently produces
  off-page strokes; decide the policy).

### T5 — Shortcuts (requirement 3)

Every action is a `Command { id, title, category, when, run }`. Keymap in a
hot-reloaded `keymap.toml`. Ship `keymap.default.toml` that user entries override
**per-entry**, not wholesale.

Must include:
- **Spring-loaded tools** (hold `E` = eraser, release = revert). Biggest speed
  win in any ink app; almost nobody ships it.
- **Command palette** (Ctrl+Shift+P) — free once commands are data, and makes the
  app discoverable without menus.
- Pen barrel button and eraser end bindable like keys.

### T6 — Modern UI (requirement 1)

Reference is Drawboard PDF. Concretely what makes it feel modern:
- **Document-first chrome**: page fills the window, toolbars float over it
  translucently and **fade out while the pen is down**. This alone is ~60% of the
  effect.
- One edge-docked icon rail, ~44px targets — not menu bar + toolbar + statusbar.
- **Contextual property popovers** with live preview, not modal preference dialogs.
- **Radial menu on the pen barrel button** (Drawboard's pen wheel) — much faster
  than travelling to a toolbar on an indirect tablet.
- Dark-first, real spacing scale, one accent colour, subtle borders, no bevels.
- Animate popovers only (120–150 ms ease-out). **Never animate anything the pen
  touches.**

Build this at T6, not earlier. A beautiful shell over laggy ink is the trap.

### T7 — Later

- **Infinite canvas** (requirement 6, explicitly optional). `SheetKind::FreeCanvas`
  exists and is skipped cleanly on write. Materialise by computing the content
  bbox, snapping to a page-size grid, and **tiling into real pages**, storing the
  true unbounded coordinates in the sidecar. **Do not use PDF's `/UserUnit`** for
  giant pages — most readers ignore it, silently breaking portability.
- **Schneider least-squares curve fitting** — fewer segments for the same
  accuracy. A genuine size optimisation, genuinely optional.
- **CRDT merge.** Every stroke has a UUID, strokes are immutable, deletions are
  tombstones. Merging two divergent files is `union(strokes) − union(tombstones)`
  with a Lamport clock. Unusually tractable in this domain, and no FOSS notes app
  does it properly. If you want one feature that justifies the project existing
  beyond the format, this is it.

---

## 7. Scope discipline

The realistic v1 is: **"PDF annotator with excellent pressure ink, split view,
that saves back into the PDF."** That is already better than every tool the user
evaluated. Infinite canvas, mobile apps, and collaboration are not v1.

Explicit v1 non-goals: handwriting recognition/OCR, real-time collaboration,
cloud accounts or any custom backend, audio recording, raster brushes/textures,
tilt, Windows 7/8, plugin system.

---

## 8. Licence

**MPL-2.0**, chosen deliberately: copyleft on these files, but linkable from an
App Store binary. Keep it. It is the reason the PDF engine must be PDFium.

---

## 9. If you get stuck

- `inkwell/README.md` — the format, the findings, the limitations
- `inkwell/AGENTS.md` — core-crate rules
- `inkwell-m0/README.md` — how to run and interpret the latency test
- `inkwell-m0/AGENTS.md` — spike rules
- `SPEC.md` — the full original architecture, including latency budget
  breakdown, Windows pen API specifics, sync design, and the stack decision matrix

When something is unverifiable in your environment (native linking, pen input,
rendering feel), **say so explicitly rather than asserting it works.** The prior
work's most useful habit was distinguishing measured facts from assumptions, and
the three real bugs found so far were all caught by tests, not by review.
