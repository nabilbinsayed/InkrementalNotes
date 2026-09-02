# Plan 044: Persist Sticky Notes as Real PDF Text Objects

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: Written against working tree at `aef1b6a`.
> Confirm excerpts match; on mismatch STOP and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/041-save-pipeline-integrity.md (uses the `images`
  payload path wired there; text payload follows the same pattern)
- **Category**: bug / feature-completion
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

Sticky notes (`state.textObjects`) are journaled ONLY to the WAL
(`journal_text_mutation`) and never written into the PDF. `save_pdf` truncates
the WAL after every successful save, so every saved note is permanently
destroyed on reload. Images survive only because `save_pdf` already embeds an
optional `images` list (Plan 041 wires the frontend to send it). This plan
gives text objects the same treatment: embed them as standard PDF text objects
via PDFium so notes survive save/reload AND remain visible in other PDF readers
(consistent with repo rule: output is always a valid, standard PDF).

## Current state

- `inkwell/crates/inkwell-pdf/src/images.rs` — the pattern to copy:
  ```rust
  pub struct ImageAnnotation {
      pub sheet: usize, pub x: f64, pub y: f64,
      pub width: f64, pub height: f64, pub data_url: String,
  }
  pub fn embed_images_in_pdf(pdfium: &Pdfium, pdf_bytes: &[u8], images: &[ImageAnnotation])
      -> Result<Vec<u8>, PdfiumError> { ... }
  ```
  It loads the doc from bytes, adds page objects per annotation, returns new bytes.
- `inkwell-app/src-tauri/src/commands.rs`:
  - `FrontendText` struct (lines 119–132): `{id, sheet, x, y, text, font_size,
    color, bold, italic, width, height}`.
  - `save_pdf` lines 863–877: if `images` provided and non-empty →
    `inkwell_pdf::embed_images_in_pdf(pdfium, original_bytes, img_list)`;
    else base = original bytes. Text has NO equivalent branch.
- `inkwell/crates/inkwell-pdf/src/lib.rs` — re-exports; add the new module here.
- pdfium-render **0.9.3** API (verified present in the local cargo registry):
  `PdfPageObjects::create_text_object(...)` exists in
  `src/pdf/document/page/object.rs`; fill color via `set_fill_color(PdfColor)`
  (see `object/group.rs:625` for the signature shape); positioning via the
  `translate(PdfPoints, PdfPoints)` transform helper (`src/pdf/transform.rs:136`).
- Frontend text coordinate convention: `x,y` are page-local points with origin
  TOP-LEFT of the page (see compositor rendering at compositor.js:214 which
  draws with `textBaseline='top'`). PDF coordinates are BOTTOM-LEFT origin.
  The ink writer already solves this flip — find it: `rg -n "height_pt|842" 
  inkwell/crates/inkwell-core/src/pdf.rs` shows the y-flip used for ribbons;
  reuse the same formula for text baselines.
- Font size: frontend stores px-ish units (~16). Treat as points directly.
- Color: frontend stores CSS hex string (`'#141724'`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all pass |
| Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |
| Backend check | `cd inkwell-app/src-tauri; cargo check` | exit 0 |

## Scope

**In scope**:
- `inkwell/crates/inkwell-pdf/src/text_embed.rs` (NEW — model after images.rs)
- `inkwell/crates/inkwell-pdf/src/lib.rs` (module + re-export)
- `inkwell/crates/inkwell-pdf/Cargo.toml` (only if a hex-parsing dep is needed — prefer hand-rolled hex decode, no new deps)
- `inkwell-app/src-tauri/src/commands.rs` (save_pdf text branch)
- `inkwell-app/src/js/core/ipc.js` (send texts in save payload)
- `inkwell-app/src/js/main.js` (pass state.textObjects through)

**Out of scope** (do NOT touch):
- `inkwell/crates/inkwell-core/**` — the sidecar/stroke writer stays untouched;
  text embedding happens on the PDFium side exactly like images.
- WAL format or replay logic.
- Rendering of text objects in the frontend canvas (already works).
- Editing UX for notes (Plan 043).

## Git workflow

- Branch: `advisor/044-sticky-note-pdf-persistence`
- Commit per step; style: `feat(pdf): embed sticky notes as standard PDF text objects`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create the text embedding module

Create `inkwell/crates/inkwell-pdf/src/text_embed.rs` mirroring images.rs:

```rust
pub struct TextAnnotation {
    pub sheet: usize,
    pub x: f64,
    pub y: f64,        // top-left origin, page-local points (frontend convention)
    pub text: String,
    pub font_size: f64,
    pub color: String, // "#RRGGBB"
    pub bold: bool,
    pub italic: bool,
}

pub fn embed_texts_in_pdf(pdfium: &Pdfium, pdf_bytes: &[u8], texts: &[TextAnnotation])
    -> Result<Vec<u8>, PdfiumError>
```

Implementation contract:
- Load doc from bytes; skip empty list (return input unchanged).
- For each annotation: get page `sheet`; create a text object with the text
  content; set size `font_size`; set fill color parsed from hex (reject/handle
  parse failure by defaulting to black — do not panic); apply bold/italic by
  requesting the corresponding base-14 font name ("Helvetica-Bold",
  "Helvetica-Oblique", "Helvetica-BoldOblique", else "Helvetica") IF the
  pdfium-render font API takes a name/family; otherwise set what the API
  supports and note the limitation in a doc comment.
- Position: convert top-left y to baseline y:
  `baseline_y = page_height - y - font_size` (matches the ink writer's flip
  convention; verify against pdf.rs before committing).
- Multi-line: split `text` on '\n'; one text object per line, each offset by
  `font_size * 1.35 * line_index` downward (mirrors compositor.js lineHeight).
- Return `doc.save_to_bytes()`.

Add `mod text_embed; pub use text_embed::{TextAnnotation, embed_texts_in_pdf};`
to lib.rs following the existing export style.

**Verify**: `cd inkwell; cargo check -p inkwell-pdf` → exit 0. If
`create_text_object` or the font API differs from this sketch, adapt to the
real signatures — read the registry source under
`~/.cargo/registry/src/*/pdfium-render-0.9.3/src/pdf/document/page/object.rs`
before writing code.

### Step 2: Unit test the round trip

In `inkwell/crates/inkwell-pdf/tests/` (find the existing integration test
file — `tests/integration.rs`), add a test modeled on the existing image
embedding test (locate it first; if none exists, model on any test that builds
bytes with `PdfFile::open`):

- Build a minimal 1-page PDF (reuse whatever fixture/helper existing tests use).
- Embed one `TextAnnotation { sheet: 0, x: 100, y: 100, text: "Inkwell note",
  font_size: 16, color: "#141724", bold: false, italic: false }`.
- Re-open the result with PDFium and assert `extract_text(&doc, 0)` contains
  "Inkwell note" (use `inkwell_pdf::extract_text`).
- Name the test after the bug: `saved_sticky_note_survives_round_trip`.

**Verify**: `cd inkwell; cargo test -p inkwell-pdf saved_sticky_note_survives_round_trip` → passes.

### Step 3: Wire the backend save branch

In `commands.rs` `save_pdf`: add parameter `texts: Option<Vec<FrontendText>>`.
After the image-embedding block produces `base_with_images`, add:

```rust
let base_with_texts = if let Some(ref text_list) = texts {
    if !text_list.is_empty() {
        let annotations: Vec<inkwell_pdf::TextAnnotation> = text_list.iter()
            .filter(|t| !t.text.trim().is_empty())
            .map(|t| inkwell_pdf::TextAnnotation {
                sheet: t.sheet, x: t.x, y: t.y, text: t.text.clone(),
                font_size: t.font_size, color: t.color.clone(),
                bold: t.bold, italic: t.italic,
            }).collect();
        let pdfium_guard = state.pdfium.lock().unwrap();
        let pdfium = pdfium_guard.as_ref()
            .ok_or("PDFium is unavailable for text embedding")?;
        inkwell_pdf::embed_texts_in_pdf(pdfium, &base_with_images, &annotations)
            .map_err(|e| format!("Failed to embed text in PDF: {e:?}"))?
    } else { base_with_images }
} else { base_with_images };
```

and use `base_with_texts` for the `PdfFile::open` step. Update
`save_pdf_dialog` signature identically (it forwards to `save_pdf`).

IMPORTANT ordering constraint (repo hard rule): embedding mutates the base
BEFORE the incremental ink write, exactly like images — keep that order.

**Verify**: `cd inkwell-app/src-tauri; cargo check` → exit 0.

### Step 4: Send texts from the frontend

In `ipc.js` extend the save payload builder from Plan 041 with:

```js
texts: (texts || []).map(t => ({
  id: String(t.id), sheet: t.sheet || 0, x: t.x, y: t.y,
  text: t.text || '', font_size: t.fontSize || 16, color: t.color || '#141724',
  bold: !!t.bold, italic: !!t.italic, width: t.width || 120, height: t.height || 30,
})),
```

Update `main.js` `file.save` to pass `state.textObjects` as the third list.
Update `savePdf(pathStr, strokes, images, texts)` signature accordingly.

**Verify**: `node --check` both files → exit 0.

### Step 5: Full battery

**Verify**:
- `cd inkwell; cargo test --workspace -- --test-threads=1` → all pass incl. the new round-trip test.
- `cd inkwell; cargo clippy --all-targets` → zero warnings.
- `cd inkwell-app; py -3 test_app_smoke.py` → 8/8.

Manual verification for the operator: open a PDF → press T → place a note,
type "persist me", Enter → Ctrl+S → close app → reopen the same file → the
note text renders on the page AND appears when selecting text with the text
selection tool (proving it is real PDF text, not pixels).

## Test plan

- New Rust test: `saved_sticky_note_survives_round_trip` (Step 2), modeled on
  the existing integration tests in `inkwell/crates/inkwell-pdf/tests/`.
- Existing suites must stay green (format untouched — embedding is appended
  content via PDFium, same as images).

## Done criteria

ALL must hold:
- [ ] New round-trip test exists and passes
- [ ] `cargo test --workspace -- --test-threads=1` exit 0
- [ ] `cargo clippy --all-targets` zero warnings
- [ ] `rg -n "texts" inkwell-app/src/js/core/ipc.js` → payload includes texts
- [ ] No new dependencies added to any Cargo.toml
- [ ] No files outside scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- pdfium-render 0.9.x lacks a usable text-object creation API (check the
  vendored registry source first; report exact findings).
- The y-flip formula contradicts what `inkwell-core/src/pdf.rs` actually does
  for ribbons (do not guess — read it).
- Embedding text causes `PdfFile::open` on the embedded bytes to fail
  (normalisation interplay) — report the error instead of bypassing checks.

## Maintenance notes

- Deleted notes: deletion currently only journals; after this plan a deleted
  note reappears on save because the frontend sends only live objects —
  VERIFY during implementation that `state.textObjects` filtered for
  `.deleted` is what gets sent (mirror the strokes filter from Plan 041) and
  note the behavior in the PR.
- Reviewer focus: font fallback behavior and the cap on notes per save (none
  today; fine for v1).
- Follow-up deferred: bold/italic fidelity depends on PDFium font resolution —
  if the API only supports Helvetica family, record that in the module docs.
