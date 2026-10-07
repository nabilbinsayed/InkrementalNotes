# Plan 059: Lossless Media Sidecar Serialization & Annotation Isolation

## Goal Description
Resolve the core "File over App" architectural defect where pasted images and interactive sticky notes become permanently baked into the base PDF underlay on save.

Currently, ink strokes round-trip losslessly through the Layer 3 embedded sidecar (`IWDC`), but images and sticky notes are stamped directly into base PDF page content streams via PDFium and discarded from the sidecar. Upon reopening a saved PDF:
1. Images and sticky notes are rendered into the background tile bitmaps by PDFium because they became permanent page content.
2. The frontend receives empty image and text state arrays because the sidecar only stored ink strokes.
3. Users cannot select, move, edit, or delete previously saved images or sticky notes.
4. Resaving compounds duplicates on top of the immutable background underlay.

This plan elevates images and text objects into first-class citizens of the core `Document` model, stores them in the Layer 3 sidecar for 100% lossless re-editing across sessions, and outputs them as standard ISO 32000 `/Annot` objects with `/AP` appearance streams (Layer 1 & 2) instead of destructively mutating base page content.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        THREE-LAYER ARCHITECTURE                        │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 1: Visual (Universal ISO 32000 PDF)                              │
│   • Strokes: Filled Bézier ribbon paths ('f' operator).                │
│   • Images:  Form XObject appearance stream rendering Image XObject.   │
│   • Text:    Form XObject appearance stream rendering BT/Tf/Tj/ET.     │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Semantic (/Annot with /AP & /Inkw_Sid)                        │
│   • Strokes: /Subtype /Ink with /InkList centrelines.                  │
│   • Images:  /Subtype /Stamp with /Rect bounds.                        │
│   • Text:    /Subtype /FreeText with /Contents & /DA.                  │
│   • All tagged with /Inkw_Sid: Dropped & replaced cleanly on resave.   │
│   • PDFium tile rasterizer (render_annotations: false) ignores them!   │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Lossless Sidecar (/Inkw_Doc stream in /EmbeddedFiles)         │
│   • Strokes: Varint-delta sample streams (x, y, p, t).                 │
│   • Images:  ImageObject { id, sheet, x, y, width, height, data_url }. │
│   • Text:    TextObject { id, sheet, x, y, text, fontSize, ... }.      │
│   • Fully deserialized on open_pdf -> 100% re-editable in InkWell!     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## User Review Required

> [!IMPORTANT]
> **Sidecar Format Evolution & Backward Compatibility**:
> The `IWDC` sidecar container in `inkwell-core` currently stores `sheets` with only `layers: Vec<Layer>` (holding strokes). We will extend `Sheet` to include `images: Vec<ImageObject>` and `text_objects: Vec<TextObject>`.
> By leveraging `#[serde(default)]`, legacy v1 sidecars will continue to decode without errors (defaulting to empty image/text vectors), while v2 sidecars will serialize and deserialize all media losslessly.

> [!IMPORTANT]
> **Deprecating Destructive Base Page Content Mutation**:
> We will eliminate `page.objects_mut().add_image_object(...)` and `add_text_object(...)` in `inkwell-pdf`. Modifying base page streams permanently alters the document and makes it impossible for the on-demand tile rasterizer to separate original document content from editable user annotations.

---

## Open Questions

> [!NOTE]
> **Image Binary Encoding in Sidecar**:
> Should images in the Layer 3 sidecar be stored as Base64 Data URLs (matching current frontend IPC format) or compressed binary chunks?
> **Recommendation:** Store as Data URLs in the JSON skeleton for v1/v2 simplicity and zero-conversion IPC roundtripping. A single handwritten page rarely carries more than a few images, so standard zlib compression of the `/Inkw_Doc` stream will keep file size negligible (<100KB).

---

## Proposed Changes

Grouped by component layer and ordered dependency-first.

---

### Component 1: Core Document Model & Sidecar Codec (`inkwell-core`)

#### [MODIFY] `inkwell/crates/inkwell-core/src/doc.rs`
1. Define `ImageObject` and `TextObject` structs with `Serialize` and `Deserialize`.
2. Add `pub images: Vec<ImageObject>` and `pub text_objects: Vec<TextObject>` to `Sheet` with `#[serde(default)]`.
3. Add helper methods to `Sheet` and `Document`:
   - `push_image`, `remove_image`, `get_image`
   - `upsert_text_object`, `remove_text_object`, `get_text_object`
4. Update `encode_sidecar` to serialize `images` and `text_objects` as part of the JSON skeleton.
5. Update `decode_sidecar` to populate `sheet.images` and `sheet.text_objects` from the decoded JSON.

```rust
// Proposed structs in inkwell-core/src/doc.rs
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageObject {
    pub id: String,
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub data_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextObject {
    pub id: String,
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub font_size: f64,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sheet {
    pub kind: SheetKind,
    pub layers: Vec<Layer>,
    #[serde(default)]
    pub images: Vec<ImageObject>,
    #[serde(default)]
    pub text_objects: Vec<TextObject>,
}
```

---

### Component 2: PDF Incremental Annotation Writer (`inkwell-core`)

#### [MODIFY] `inkwell/crates/inkwell-core/src/pdf.rs`
1. In `write_document_with_boxes`, iterate over `sheet.images` and `sheet.text_objects` alongside `sheet.strokes()`.
2. Implement `emit_image_annot(&mut self, img: &ImageObject, page_box: [f64; 4]) -> Option<u32>`:
   - Decode image dimensions and RGB/RGBA/JPEG payload from `img.data_url`.
   - Emit an Image XObject stream (`/Subtype /Image`).
   - Emit a Form XObject appearance stream (`/Subtype /Form`) that performs `q {w} 0 0 {h} {x} {y} cm /Im Do Q`.
   - Emit an annotation dictionary (`/Type /Annot /Subtype /Stamp /Rect [...] /AP << /N {ap} 0 R >> /Inkw_Sid (img_{id}))`.
3. Implement `emit_text_annot(&mut self, text_obj: &TextObject, page_box: [f64; 4]) -> Option<u32>`:
   - Compute text bounding box in PDF coordinate space.
   - Emit a Form XObject appearance stream rendering the text lines using standard PDF text operators (`BT /Helv ... Tf ... Tj ET`).
   - Emit an annotation dictionary (`/Type /Annot /Subtype /FreeText /Rect [...] /Contents (...) /DA (...) /AP << /N {ap} 0 R >> /Inkw_Sid (txt_{id}))`.
4. Include all generated annotation object numbers in the `annots` array passed to `rewrite_page`.
   - Because `rewrite_page` drops existing annotations tagged with `/Inkw_Sid`, all previous InkWell annotations (strokes, images, text) are replaced atomically on each incremental save.
   - The base page `/Contents` stream remains completely pristine.

---

### Component 3: Tauri IPC & Application State (`inkwell-app/src-tauri`)

#### [MODIFY] `inkwell-app/src-tauri/src/commands.rs`
1. In `open_pdf` and `open_pdf_bytes`:
   - After `inkwell_core::pdf::read_sidecar(&arc_bytes)` successfully extracts the `doc`, populate `loaded_images` and `loaded_texts` directly from `doc.sheets`.
   - Replay any uncommitted WAL entries on top of the loaded state (in case of crash recovery).
   - Return populated `loaded_images` and `loaded_texts` in `OpenPdfResult`.
2. In `save_pdf`:
   - Synchronize incoming `images` and `texts` arguments directly into `doc.sheets[..].images` and `doc.sheets[..].text_objects`.
   - Remove the calls to `inkwell_pdf::embed_images_in_pdf` and `inkwell_pdf::embed_texts_in_pdf` that were mutating base PDF bytes.
   - Invoke `pdf_file.write_document(doc, ...)`.
   - Atomically commit the updated PDF with ink, images, and text annotations cleanly appended.
3. In `commit_stroke`, `journal_image_mutation`, and `journal_text_mutation`:
   - Keep in-memory `doc` synchronized so `state.doc` always reflects the live workspace.

---

### Component 4: Frontend Workspace & Compositor Coordination (`inkwell-app/src/js`)

#### [MODIFY] `inkwell-app/src/js/core/document.js`
1. When `openDocument` resolves `res = await ipc.openPdf(path)`:
   - Ensure `state.images = res.loaded_images || []`.
   - Ensure `state.textObjects = res.loaded_texts || []`.
   - Trigger `compositor.scheduleRedrawAll()` and re-bind images for immediate display.

#### [MODIFY] `inkwell-app/src/js/render/compositor.js`
1. Confirm that `redrawAll()` renders `state.images` and `state.textObjects` on the `#dry` canvas without interference.
2. Confirm that PDFium background tiles (rendered via `render_annotations(false)`) remain completely clean without ghosting or double-rendered images.

---

## Verification Plan

### Automated Tests
1. **Rust Core Tests:**
   ```bash
   cd inkwell
   cargo test --workspace -- --test-threads=1
   ```
   - Add new unit tests in `inkwell/crates/inkwell-core/tests/integration.rs`:
     - `test_sidecar_roundtrip_with_images_and_text`: Verifies that a `Document` with strokes, images, and text objects encodes and decodes losslessly through `encode_sidecar` and `decode_sidecar`.
     - `test_incremental_save_replaces_image_and_text_annotations`: Verifies that saving a document multiple times with modified images and text objects updates the `/Annots` array via `/Inkw_Sid` without duplicating objects or modifying base page contents.
     - `test_legacy_v1_sidecar_backwards_compatibility`: Verifies that older v1 sidecars without image/text fields decode without error.

2. **Clippy Quality Verification:**
   ```bash
   cd inkwell
   cargo clippy --all-targets
   ```

### Manual Verification
1. **Create and Save Full Media Document:**
   - Launch `Launch Inkwell.sh` (or `Launch Inkwell.bat`).
   - Create a new notebook (`Ctrl+N`).
   - Draw pen strokes with pressure variations.
   - Paste a screenshot image (`Ctrl+V`) and resize it with lasso handles.
   - Create a sticky text note (`T`), type notes, and format with bold/italic.
   - Save document (`Ctrl+S`) as `media_test.pdf`.
2. **Quit and Reopen in InkWell:**
   - Close InkWell completely (`Alt+F4` or window close).
   - Reopen `media_test.pdf` in InkWell.
   - **Check 1:** Verify the background tile is clean (no ghosted duplicates under the interactive objects).
   - **Check 2:** Select the lasso tool (`V`), click on the pasted image, drag it to a new position, and resize it.
   - **Check 3:** Click on the sticky note, edit the text string in the inline editor, and commit changes.
   - **Check 4:** Save the document again (`Ctrl+S`).
3. **Third-Party PDF Reader Validation:**
   - Open `media_test.pdf` in Google Chrome and Adobe Acrobat.
   - Verify that strokes, the moved image, and the edited sticky note all render crisply and accurately as standard vector annotations.
