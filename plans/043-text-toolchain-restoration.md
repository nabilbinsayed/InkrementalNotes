# Plan 043: Restore the Text Toolchain — Selection Tool Activation, Copy Path, Sticky-Note Editor & Search Drawer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: Written against working tree at `aef1b6a` with
> uncommitted Plan-038 cutover changes. Confirm each excerpt still matches;
> on mismatch STOP and report.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW–MED
- **Depends on**: none (independent of 041/042)
- **Category**: bug
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

The entire text toolchain lost its activation paths in the modular-frontend
cutover: the Text Selection dock button has no click listener (the tool is
unreachable), the selection popover's five action buttons are wired to nothing,
Ctrl+C ignores selected PDF text, the sticky-note editor references DOM nodes
that do not exist in the HTML (so pressing T and clicking does literally
nothing), and the search drawer's input/button/results are unwired. These are
user-reported breakages. The engine code underneath
(`workspace/text-selection.js`, backend `get_page_text_data`, `search_pdf`)
is intact and tested by Rust tests — only the wiring is missing.

## Current state

- `inkwell-app/src/index.html`:
  - Line 637: `<button id="btnDockTextSelect" class="dock-btn" title="Text Selection Tool (S)" ...>` — `rg -n "btnDockTextSelect" inkwell-app/src/js` returns NOTHING: no listener exists.
  - Lines 367–388: `#textSelectionPopover` with buttons `btnTextCopy`,
    `btnTextHighlight`, `btnTextUnderline`, `btnTextStrikethrough`,
    `btnTextSearch` — none referenced in any JS file.
  - The sticky-note editor markup (`#inlineTextEditor`, `#inlineTextarea`)
    DOES NOT EXIST in index.html. But `tools/text.js` requires it:
    ```js
    // tools/text.js lines 40-42
    const editor = $('inlineTextEditor');
    const textarea = $('inlineTextarea');
    if (!editor || !textarea || !viewport) return;   // silent no-op today
    ```
  - Search drawer markup exists: `drawerSearchInput`, `btnExecuteSearch`,
    `drawerSearchResults` (all unreferenced in JS).
- `inkwell-app/src/js/workspace/text-selection.js`:
  - `copySelectedPdfText()` (lines 332–340) writes
    `state.selectedTextString` to the clipboard — never called anywhere.
  - `clearTextSelection()` (342–350), `ensurePageTextData(sheet)` (10–41),
    `findCharAndOffsetAtPageCoord` (149–238), `computeTextSelectionRanges`
    (240–296), `expandSelectionToWord/Line` (298–330) — all functional.
- `inkwell-app/src/js/main.js`:
  - Pointer handlers already implement the full `textSelect` interaction
    (pointerdown lines 503–531, move 554–563, up 580–586) — they work once the
    tool can be activated.
  - `edit.copy` command (lines 179–189) calls only
    `clipboard.copySelection()` which returns false when no INK objects are
    selected — PDF text selection is ignored.
  - `tool.text` command (line 259) sets tool `'text'`; there is NO command for
    `'textSelect'`.
- `inkwell-app/src/js/ui/drawers.js`: wires rail buttons to
  `toggleDrawer('search')` etc. (lines 21–35) so the drawer OPENS, but nothing
  binds its contents.
- Backend commands exist and match: `search_pdf(query)` →
  `Vec<SearchResultItem{page_index, snippet, match_count}>`
  (commands.rs:1059–1116); `get_page_text_data(pageIndex)` → PageTextData
  (commands.rs:1139–1162). NOTE: `search_pdf` returns page-level hits with
  snippets but NOT highlight rectangles; the existing overlay renderer
  `overlays.js drawSearchHighlights(ctx, state, viewport, dpr, panes, clipPaneFn)`
  (lines 270–298) expects `state.searchResults[i] = { pageIndex, rect:[x0,y0,x1,y1] }`.
  Rectangles must be derived client-side from `pageTextData` char rects
  (see Step 4).
- Styling for the popover/editor already exists in `styles.css`
  (`.text-selection-popover` line ~3828 area, `.sel-action-btn`). Verify the
  classes you use already have styles; do not invent new class names.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| JS syntax check | `node --check <edited file>` per file | exit 0 |
| App smoke | `cd inkwell-app; py -3 test_app_smoke.py` | 8/8 pass |

## Scope

**In scope**:
- `inkwell-app/src/index.html` (add editor markup ONLY; no other structural changes)
- `inkwell-app/src/js/main.js`
- `inkwell-app/src/js/ui/toolbar.js` (dock button binding)
- `inkwell-app/src/js/tools/text.js` (only if commit/cancel bindings need exports)
- `inkwell-app/src/js/workspace/text-selection.js` (add rect-building helper)
- `inkwell-app/src/js/ui/drawers.js` (search drawer wiring)

**Out of scope** (do NOT touch):
- `workspace/text-selection.js` selection MATH (findChar/computeRanges) — it
  works; Plan 037's accuracy overhaul is tracked separately as UNFIXED.
- Highlight/Underline/Strikethrough PDF annotation WRITING — that requires new
  PDF writer features (core crate). In this plan those two buttons get hidden
  (see Step 2); do not fake them.
- Rust backend files.
- `styles.css` unless a class genuinely has no rule (check first).

## Git workflow

- Branch: `advisor/043-text-toolchain-restoration`
- Commit per step; style: `fix(ui): restore text selection, sticky notes and search wiring`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Activate the Text Selection tool

In `ui/toolbar.js` `bindDockButtons()`, add alongside the other dock bindings:

```js
$('btnDockTextSelect') && $('btnDockTextSelect').addEventListener('click', () => {
  toolManager.setTool('textSelect');
  updateToolbarUI();
});
```

In `main.js` `registerCoreCommands()` add:

```js
reg.register({ id: 'tool.textSelect', title: 'Text Selection', category: 'Tools', shortcut: 'S',
  execute: () => { toolManager.setTool('textSelect'); toolbar.updateToolbarUI(); } });
```

Also extend `updateToolbarUI()`'s `toolButtonMap` with
`textSelect: $('btnDockTextSelect')` so the button shows its active state.
Check `styles.css` for a `.dock-btn.active` rule (it exists for other tools).

**Verify**: `node --check` both files → exit 0;
`rg -n "btnDockTextSelect" inkwell-app/src/js` → ≥3 matches.

### Step 2: Wire the selection popover (copy + search; hide the rest)

In `main.js`, add a helper and wire it after selection changes:

```js
function updateTextSelectionPopover() {
  const pop = $('textSelectionPopover');
  if (!pop) return;
  const sel = state.textSelection;
  if (sel && sel.text && sel.text.trim() && (state.activeTool === 'textSelect')) {
    const anchorRect = sel.rects && sel.rects[0] ? sel.rects[sel.rects.length - 1].rect : null;
    if (anchorRect && _viewport) {
      const pl = _viewport.getPageLayout(sel.sheet);
      const [sx, sy] = _viewport.worldToScreen(pl.x + anchorRect[2], pl.y + anchorRect[3], 'left');
      pop.style.left = Math.min(sx, window.innerWidth - 220) + 'px';
      pop.style.top = (sy + 12) + 'px';
    }
    pop.classList.remove('hidden');
  } else {
    pop.classList.add('hidden');
  }
}
on('selectionChanged', updateTextSelectionPopover);
```

Call `updateTextSelectionPopover()` at the end of the `textSelect` branches in
the pointerdown/pointerup handlers (after `compositor.redrawAll()`), and hide
it in the other tools' pointerdown branch.

Button actions:
- `btnTextCopy` → `textSelection.copySelectedPdfText()` then hide popover.
- `btnTextSearch` → put `state.selectedTextString` into the search drawer
  input and trigger the same search routine as Step 4, then open the drawer
  via the existing `toggleDrawer('search')` path exposed by drawers.js
  (export it if needed).
- `btnTextHighlight`, `btnTextUnderline`, `btnTextStrikethrough`: ADD the
  `hidden` attribute in `index.html` with an HTML comment
  `<!-- PDF annotation writing not yet implemented (Plan 044 follow-up) -->`.
  Hiding beats faking.

**Verify**: `node --check inkwell-app/src/js/main.js` → exit 0.

### Step 3: Make Ctrl+C copy selected PDF text

In `main.js` `edit.copy` execute body, before the clipboard fallback:

```js
execute: () => {
  if (state.activeTool === 'textSelect' && state.selectedTextString &&
      textSelection.copySelectedPdfText()) {
    return;
  }
  if (clipboard.copySelection()) {
    toast.showToast('Copied to clipboard', 'info');
  }
},
```

(`textSelection` is already imported at main.js line 27.)

**Verify**: `node --check inkwell-app/src/js/main.js` → exit 0.

### Step 4: Recreate the sticky-note editor DOM

`tools/text.js` needs `#inlineTextEditor` containing `#inlineTextarea`. Add to
`index.html` immediately before the closing `</div>` of `#app-container`
(keep classes consistent with existing glassmorphic modals — reuse the
`insertPageModal` card pattern):

```html
<div id="inlineTextEditor" class="inline-text-editor hidden">
  <textarea id="inlineTextarea" rows="2" spellcheck="false"></textarea>
</div>
```

Check `styles.css` for `.inline-text-editor`; if absent, add a minimal rule
(absolute positioning, z-index above canvases, dark card background matching
`--panel` variables used by `.more-options-menu`).

Then wire commit/cancel in `main.js` `bindAllUIEvents()`:

```js
const textarea = $('inlineTextarea');
if (textarea) {
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); textTool.cancelEditing(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textTool.commitEditing(); }
  });
  textarea.addEventListener('blur', () => textTool.commitEditing());
}
```

Note `attachKeyboardShortcuts` already ignores key events while typing in a
TEXTAREA (main.js:600), so shortcuts won't fire mid-edit. The blur-commit can
double-fire after Enter-commit; guard `commitEditing()` — it already no-ops
when `_activeEditingObj` is null (text.js:66). Confirm and rely on that.

**Verify**: `node --check inkwell-app/src/js/main.js` → exit 0;
`rg -n "inlineTextEditor" inkwell-app/src/index.html` → 1 match.

### Step 5: Wire the search drawer

In `drawers.js` (or a small new section at its bottom), bind:

```js
const input = $('drawerSearchInput');
const go = $('btnExecuteSearch');
const runSearch = async () => {
  const q = (input && input.value || '').trim();
  state.searchQuery = q;
  state.searchResults = [];
  if (!q) { compositor.redrawAll(); renderSearchResults(); return; }
  const res = await ipc.invokeTauri('search_pdf', { query: q });
  state.searchResults = await buildSearchRects(q, res);
  state.activeSearchMatch = 0;
  renderSearchResults();
  compositor.redrawAll();
};
if (go) go.addEventListener('click', runSearch);
if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
```

`buildSearchRects(q, results)`: for each result `{page_index, snippet}`,
ensure `textSelection.ensurePageTextData(page_index)` then scan
`state.pageTextData[page_index].chars` for case-insensitive occurrences of
`q` (char-wise, mirroring the backend's approach); for each occurrence emit
`{ pageIndex, rect: [minX, minY, maxX, maxY] }` from the matched chars'
rects. Cap total rects at 500 to protect frame time. `renderSearchResults()`
fills `#drawerSearchResults` with one clickable row per result
("Page N — snippet", escaped via `escapeHtml` from core/state.js); clicking a
row calls the drawers' goToPage callback (`drawers.setGoToPageCallback` was
wired in main.js:638 — reuse the exported navigation path or emit through the
existing callback registry).

`drawers.js` currently imports neither ipc nor compositor — add the imports
following its existing import style.

**Verify**: `node --check inkwell-app/src/js/ui/drawers.js` → exit 0.

### Step 6: Battery

**Verify**: `cd inkwell-app; py -3 test_app_smoke.py` → 8/8 pass.

Manual click-through for the operator (record in PR description):
1. Open a text PDF → click the Text Selection dock button → cursor changes,
   drag across a sentence → blue highlight rects appear; popover appears near
   selection; Copy puts the sentence on the clipboard (paste somewhere to verify).
2. Press `S` → same tool activates.
3. Press `T` → click canvas → editable note appears; type; Enter commits and
   renders as canvas text; Escape discards.
4. Open Search drawer → type a word from the document → yellow highlights
   render on-page; clicking a result navigates to the page.

## Test plan

No JS unit runner exists yet (Plan 045). Structural checks:
- `rg -n "btnExecuteSearch|drawerSearchInput" inkwell-app/src/js` → matches exist.
- Smoke suite stays green (boot cleanliness catches syntax/import errors).

## Done criteria

ALL must hold:
- [ ] `rg -n "btnDockTextSelect" inkwell-app/src/js` → ≥3 matches
- [ ] `rg -n "inlineTextEditor" inkwell-app/src/index.html` → exactly 1 match
- [ ] `rg -n "copySelectedPdfText" inkwell-app/src/js/main.js` → ≥1 match
- [ ] `rg -n "search_pdf" inkwell-app/src/js/ui/drawers.js` → ≥1 match
- [ ] `py -3 test_app_smoke.py` → 8/8
- [ ] No files outside scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- The live `index.html` already contains `#inlineTextEditor` (drift).
- `search_pdf`'s real return shape differs from `{page_index, snippet, match_count}`.
- Wiring the search drawer would require restructuring `drawers.js` beyond
  additive bindings (its internal structure changed since this plan was written).
- Popover positioning cannot reuse `worldToScreen` because split-mode pane
  handling differs in the live tree.

## Maintenance notes

- The selection engine's ACCURACY (multi-column PDFs, rotated pages) remains
  tracked by Plan 037 (UNFIXED). This plan restores reachability only.
- If PDF annotation writing lands later (highlight/underline/strikethrough),
  unhide the three buttons and route them through the writer — do not render
  them as canvas-only fakes.
- Reviewer focus: the `buildSearchRects` cap (500) and that `ensurePageTextData`
  promises are reused (no duplicate IPC storms when typing fast).
