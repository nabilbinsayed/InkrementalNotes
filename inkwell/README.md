# Inkwell — core

The correctness-critical half of the project: document model, ink maths, the
PDF-native file format, crash-safe autosave, and the underlay tile cache.

**No UI. No windowing. No shell dependency.** Deliberately — so the choice
between a Tauri shell and a native winit/wgpu shell stays reversible without
touching any of this. The M0 latency gate decides the shell; nothing here cares.

```
crates/inkwell-core/src/
  ink.rs      One-Euro filter, brush, StrokeBuilder, RDP simplify, ribbon outline
  codec.rs    varint-delta stroke encoding (~4 bytes/sample, 10-bit pressure)
  doc.rs      Document / Sheet / Layer / Viewport + sidecar container
  pdfobj.rs   shallow byte-level PDF reader (classic xref only — see Limitations)
  pdf.rs      the three-layer incremental writer + crash recovery
  tiles.rs    LOD tile cache for the PDF underlay
  (tests/)    integration.rs, tiles.rs, geometry.rs
  wal.rs      write-ahead log, flush policy, atomic writes
```

## Verify it yourself

```bash
./tools/run_validation.sh
```

That runs, in order: fixture generation, `cargo test` (37 tests), three autosave
generations through the real writer, then **cross-language validation** — the
part that actually matters.

`cargo test` only proves the Rust agrees with itself. `tools/validate.py` proves
the *file* is correct according to software that has never heard of Inkwell:

| Engine | Question it answers |
|---|---|
| **Poppler** (`pdftotext`) | Is the original document still intact? |
| **pypdf** | Is the object and annotation structure well formed? |
| **PyMuPDF** (MuPDF) | Does a completely independent renderer draw the ink? |

Current status: **43/43 Rust tests, 24/24 cross-language checks, 0 clippy warnings.**

## The format, in one table

One standard PDF carries three layers at once.

| Layer | What | Who reads it | Lossy? |
|---|---|---|---|
| 1 · visual | variable-width ribbons as **filled** vector paths | every PDF reader ever made | resolution-independent |
| 2 · interop | `/Ink` annotations with `/AP` appearance streams | Acrobat, Okular, Xodo, Preview | no pressure |
| 3 · data | compressed sidecar under private `/Inkw_*` keys | only Inkwell | lossless |

**Why filled paths and not strokes.** PDF's stroke operator has exactly one line
width. Pressure cannot be expressed with it. So we offset the centreline by the
pressure-derived half-width on both sides, close it with round caps, and fill it.
That single decision is what lets pressure survive into a file Chrome can open.

**Why a private layer.** Layers 1 and 2 cannot carry pressure, timestamps, tool
identity, or layer structure. ISO 32000 guarantees conforming readers ignore
dictionary keys they don't recognise, so the editable data rides along
invisibly. Apple's PDFKit does the same thing for Apple Pencil ink; we just
document it.

**Degradation is graceful, never fatal.** `read_sidecar` returns:

- `Ok(doc)` — full fidelity
- `Absent` — a plain PDF, or another app stripped our data → reconstruct from `/InkList`
- `Stale(doc)` — our data is present but another app changed the visuals since
- `Corrupt(why)` — present but unusable → warn and fall back

## Autosave

Saving is a **PDF incremental update**: changed objects, a new xref section, and
a trailer whose `/Prev` chains to the previous one. Append-only, so bytes already
on disk are never rewritten. Two consequences:

1. **Crash safety is structural.** A torn tail leaves the previous xref valid.
   Recovery is `truncate to the last %%EOF` — that's the entire routine
   (`pdf::recover_truncated`). Verified by tearing the file at 8 different
   offsets and reopening each one in two foreign parsers.
2. **Every generation is a recoverable snapshot**, so version history is free.

But incremental appends alone would still re-upload the whole file to Google
Drive on every tick. Hence the WAL: each committed stroke appends a few hundred
fsynced bytes to a local journal, and the PDF is only rewritten when the user
actually pauses (`FlushPolicy`: 20 s idle, focus loss, explicit save, close, or a
3-minute ceiling). Keep the journal *out* of the synced folder.

## Three things the tests caught that review would not have

All recorded here because they're the argument for writing the harness first.

**Duplicate private keys.** Appending a second generation left two `/Inkw_Doc`
entries in the catalog. Readers take the **first** definition, so the app
silently loaded stale data from generation 1 while displaying generation 2. Now
`dict_without` strips our own keys before rewriting, and
`multiple_generations_do_not_duplicate_our_objects` asserts the count.

**8-bit pressure was throwing away real data.** The codec stored pressure in one
byte. The round-trip test showed 746 distinct source levels collapsing to 229 —
Windows Ink delivers pressure at 10-bit resolution, so a byte discarded two real
bits. Pressure is now a zigzag-varint *delta* at 10-bit resolution, which is
lossless with respect to the device and costs essentially nothing, because
consecutive pressure samples barely differ.

**Faceted outlines — found by looking at a 900% render, not by a test.** The
first working version emitted the ribbon as a dense polyline, and this README
called Bézier fitting "a size optimisation, not a correctness one". Both wrong:
the straight segments were plainly visible when zoomed. Fixing it took three
attempts, and the measurements are why:

| Outline construction | Radial error on a test circle |
|---|---|
| plain polyline | 0.046 pt |
| Catmull-Rom across the *whole closed* outline | **2.37 pt** — 50× worse |
| uniform Catmull-Rom per edge, reflected end tangents | 0.027 pt |
| **centripetal knots, one-sided end tangents, per edge** | **0.0017 pt** |

The 2.37 pt disaster is the instructive one: smoothing straight through the
outline's *intentional* sharp corners (where a long edge meets a round cap) makes
the curve bulge at every stroke end. And uniform parameterisation overshoots on
the unevenly spaced points that RDP simplification deliberately produces, which
is why the knots are centripetal. `tests/geometry.rs` now pins all of this.

## Limitations, stated plainly

- **`pdfobj` handles classic cross-reference tables only.** PDFs using
  cross-reference streams and object streams (PDF 1.5+, i.e. most modern files)
  keep the catalog and page objects compressed inside object streams where
  byte-scanning cannot reach them. `PdfFile::open` returns `Error::XrefStream`
  and refuses, rather than corrupting the file — there is a test asserting
  exactly that. The production answer is to normalise on import via PDFium,
  which decompresses object streams for us. **That is the next task.**
- **`FreeCanvas` sheets are skipped on write.** Infinite canvas materialisation
  (bbox → page-size snap → tile) is M7. Skipped cleanly, never silently dropped.
- **`tiles.rs` has no real rasteriser yet.** `PageRasterizer` is a trait; PDFium
  implements it in `inkwell-pdf`. Everything easy to get wrong — LOD selection,
  visible-set computation, LRU eviction under a budget, coarser-LOD fallback so
  zooming never flashes white, and request cancellation while panning — is
  implemented and tested against a stub. Wiring PDFium in is mechanical.
- **Outline smoothing is Catmull-Rom, not a least-squares fit.** Centripetal
  knots, one-sided end tangents, applied per-edge so the cap corners stay sharp.
  Measured error on a test circle: **0.0017 pt**, versus 0.046 pt for a plain
  polyline. A Schneider least-squares fit would use fewer segments for the same
  accuracy; that is a size optimisation and it is genuinely optional.
- **RDP tolerance governs high-zoom fidelity.** `StrokeBuilder::finish(tol)` at
  0.4 pt leaves ~0.13 pt of outline error, which is faintly visible past 900%.
  Default to ~0.1 pt for note-taking; the size saving beyond that is not worth it.
- **No latency claims are made anywhere in this crate**, because none can be
  verified without hardware. See the M0 spike.

## Licence

MPL-2.0, chosen on purpose. Copyleft on these files, but linkable from an
App Store binary — unlike GPL/AGPL, which would permanently foreclose the iPad
story that requirement 5 depends on. For the same reason the PDF engine must be
**PDFium (BSD)**, not MuPDF (AGPL) or Poppler (GPL).
