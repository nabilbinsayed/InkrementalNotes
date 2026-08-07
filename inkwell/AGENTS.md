# AGENTS.md — rules for coding agents on inkwell-core

Read this before changing anything. `README.md` explains the design; this file
explains what you must not break.

## What this crate is

The correctness-critical half: file format, document model, ink maths, autosave,
tile cache. **No UI, no windowing, no shell dependency, and it stays that way.**
If you find yourself adding a window, a canvas, an event loop, or a dependency on
Tauri or winit, you are in the wrong crate.

## Hard rules

1. **The output must always be a valid, standard PDF.** No proprietary container,
   no "temporary" custom format, no sidecar file sitting next to the PDF. If a
   feature seems to need one, say so and stop; do not invent one.

2. **Writes are append-only.** `PdfFile::finish` must always produce a buffer
   whose prefix is byte-identical to its input. `appending_preserves_the_original_bytes_exactly`
   asserts this. Crash safety and cheap autosave both depend on it.

3. **Never emit ink as a stroked path.** `ribbon_outline` builds a filled
   outline because PDF's stroke operator has exactly one line width. "Simplifying"
   it to `m`/`l`/`S` silently deletes pressure sensitivity, which is the entire
   point of the project.

4. **Never rasterise the PDF underlay at import.** Tiles are rendered on demand
   per LOD. Baking a bitmap at import is precisely the defect we exist to avoid.

5. **Never strip a key you did not write.** `dict_without` exists so we replace
   *our own* `/Inkw_*` keys. Third-party annotations, form fields and metadata
   must survive untouched.

6. **Never widen `pdfobj` silently.** If you make it accept xref-stream PDFs,
   it must be because you implemented object-stream decompression correctly, with
   tests. Deleting the `Error::XrefStream` check to make a file "work" will
   corrupt users' documents.

7. **`sync_data` in `Wal::append` is load-bearing.** Do not remove it for speed.
   Do not batch appends. Flush the PDF before truncating the journal, never the
   reverse.

8. **Do not lower pressure resolution.** 10-bit delta coding matches what
   Windows Ink actually delivers. A raw byte here was a real bug.

9. **No latency claims.** This crate cannot measure latency and neither can you.
   Do not add comments or docs asserting anything about how the ink feels.

## Testing rules

- Every bug fix gets a regression test **named after the bug**, not after the
  function. See `multiple_generations_do_not_duplicate_our_objects`.
- Assert **properties**, not magic numbers, where you can. Pressure fidelity is
  checked as a ratio against the source, not an absolute count, because absolute
  counts depend on how varied the synthetic data happens to be — that exact
  mistake produced a false failure.
- If a test fails, work out whether the **test** or the **code** is wrong before
  changing either. Two of the three real findings so far were bad tests; one was
  a bad format decision. Never adjust a threshold merely to get green.
- Anything touching the file format must also pass `tools/validate.py`. Rust
  agreeing with Rust proves nothing about the bytes.

## Definition of done

- `./tools/run_validation.sh` is fully green.
- `cargo clippy --all-targets` reports zero warnings.
- New public items have doc comments explaining *why*, not *what*.
- You state plainly which claims you verified and which you did not.
