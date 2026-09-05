# Plan 053: Isolate Document Text Layer, Selection, and Search State on Document Load

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a3f3e8d..HEAD -- inkwell-app/src/js/core/document.js inkwell-app/test_app_smoke.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a3f3e8d`, 2026-09-05

## Why this matters

In `inkwell-app/src/js/core/document.js`, `setDocument()` initializes page metadata, strokes, images, and text objects when opening a document or creating a whiteboard. However, it fails to clear the text-extraction caches (`state.pageTextData`, `state.pageTextSpans`, `state.pageTextLoading`), the active text selection (`state.textSelection`, `state.selectedTextSpans`, `state.selectedTextString`), and the search state (`state.searchResults`, `state.searchQuery`, `state.isSearching`).

As a result, opening a new PDF or creating a blank whiteboard preserves cached text spans and search match rectangles from the previous document for matching page indices (e.g., page 0). Furthermore, inserting a blank page into an existing document does not invalidate or shift cached `pageTextData` indices, causing text hit-testing and search highlights to point to the wrong pages.

## Current state

The relevant files and lines:
- `inkwell-app/src/js/core/document.js` (lines 294–309):
```javascript
export function setDocument({ pageInfos = [], strokes = [], images = [], textObjects = [], outline = [], bookmarks = [] } = {}) {
  state.pageInfos = pageInfos;
  state.strokes = strokes;
  state.images = images;
  state.textObjects = textObjects;
  state.outline = outline;
  state.bookmarks = bookmarks;
  state.selectedStrokes = [];
  state.selectedImages = [];
  state.selectedTextObjects = [];
  state.isDirty = false;

  rebuildStrokesBySheet();
  history.clearHistory();
  emit('documentLoaded', { pageInfos, strokesCount: strokes.length });
}
```

- `inkwell-app/src/js/core/document.js` (lines 311–330):
```javascript
export function insertPageAtIndex(targetIndex, pageInfo) {
  if (!state.pageInfos) state.pageInfos = [];
  const insertIdx = Math.max(0, Math.min(state.pageInfos.length, targetIndex));
  state.pageInfos.splice(insertIdx, 0, pageInfo);

  // Shift sheet index of any existing strokes, images, text on or after insertIdx
  for (const s of state.strokes || []) {
    if (s.sheet >= insertIdx) s.sheet += 1;
  }
  for (const img of state.images || []) {
    if (img.sheet >= insertIdx) img.sheet += 1;
  }
  for (const t of state.textObjects || []) {
    if (t.sheet >= insertIdx) t.sheet += 1;
  }

  rebuildStrokesBySheet();
  notifyMutation('insert_page', { pageIndex: insertIdx, pageInfo });
  return insertIdx;
}
```

- `inkwell-app/src/js/core/state.js` (lines 80–97, 140–144):
Defines `pageTextSpans`, `pageTextData`, `pageTextLoading`, `selectedTextSpans`, `selectedTextString`, `textSelection`, `textSelectAnchor`, `textSelectPending`, `isSelectingText`, `searchQuery`, `searchResults`, `activeSearchMatch`, `isSearching`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop App Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all checks pass |
| Rust Workspace Tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all pass |

## Scope

**In scope**:
- `inkwell-app/src/js/core/document.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- `inkwell-app/src/js/workspace/text-selection.js`
- `inkwell-app/src/js/core/state.js`
- Backend Rust code

## Steps

### Step 1: Clear text extraction and search state in `setDocument`

In `inkwell-app/src/js/core/document.js`, update `setDocument()` to reset text cache, text selection, and search structures:

```javascript
export function setDocument({ pageInfos = [], strokes = [], images = [], textObjects = [], outline = [], bookmarks = [] } = {}) {
  state.pageInfos = pageInfos;
  state.strokes = strokes;
  state.images = images;
  state.textObjects = textObjects;
  state.outline = outline;
  state.bookmarks = bookmarks;
  state.selectedStrokes = [];
  state.selectedImages = [];
  state.selectedTextObjects = [];
  state.isDirty = false;

  // Clear PDF text layer caches, selection, and search state
  state.pageTextData = {};
  state.pageTextSpans = {};
  state.pageTextLoading = {};
  state.selectedTextSpans = [];
  state.selectedTextString = '';
  state.textSelection = null;
  state.textSelectAnchor = null;
  state.textSelectPending = null;
  state.isSelectingText = false;
  state.searchQuery = '';
  state.searchResults = [];
  state.activeSearchMatch = 0;
  state.isSearching = false;

  rebuildStrokesBySheet();
  history.clearHistory();
  emit('documentLoaded', { pageInfos, strokesCount: strokes.length });
}
```

**Verify**:
`grep -rn "state.pageTextData = {};" inkwell-app/src/js/core/document.js` → 1 match.

### Step 2: Re-index or flush text layer cache on page insertion

In `inkwell-app/src/js/core/document.js`, inside `insertPageAtIndex()`, shift cached entries in `state.pageTextData` and `state.pageTextSpans` for indices `>= insertIdx`:

```javascript
  // Shift cached page text data for indices >= insertIdx
  if (state.pageTextData && Object.keys(state.pageTextData).length > 0) {
    const newPageTextData = {};
    const newPageTextSpans = {};
    for (const key of Object.keys(state.pageTextData).map(Number).sort((a, b) => b - a)) {
      if (key >= insertIdx) {
        newPageTextData[key + 1] = state.pageTextData[key];
        if (state.pageTextSpans && state.pageTextSpans[key]) {
          newPageTextSpans[key + 1] = state.pageTextSpans[key];
        }
      } else {
        newPageTextData[key] = state.pageTextData[key];
        if (state.pageTextSpans && state.pageTextSpans[key]) {
          newPageTextSpans[key] = state.pageTextSpans[key];
        }
      }
    }
    state.pageTextData = newPageTextData;
    state.pageTextSpans = newPageTextSpans;
  }
```

**Verify**:
`grep -rn "newPageTextData" inkwell-app/src/js/core/document.js` → matches found.

### Step 3: Add text isolation verification in `test_app_smoke.py`

In `inkwell-app/test_app_smoke.py`, add a test verifying that when `documentOps.setDocument(...)` is called:
1. `state.pageTextData` is empty (`{}`).
2. `state.textSelection` is `None`.
3. `state.searchResults` is empty (`[]`).

**Verify**:
`cd inkwell-app; py -3 test_app_smoke.py` → exits 0, all checks pass.

## Test plan

- Test: Verify document reset clears `state.pageTextData`, `state.pageTextSpans`, `state.textSelection`, and `state.searchResults`.
- Test: Verify inserting a page at index 0 shifts pageTextData from key 0 to key 1.
- Verification command: `cd inkwell-app; py -3 test_app_smoke.py`

## Done criteria

Machine-checkable. ALL must hold:
- [ ] `grep -rn "state.pageTextData = {};" inkwell-app/src/js/core/document.js` returns a match.
- [ ] `grep -rn "state.searchResults = \[\];" inkwell-app/src/js/core/document.js` returns a match.
- [ ] `cd inkwell-app; py -3 test_app_smoke.py` exits 0 with all checks passing.
- [ ] No files outside `inkwell-app/src/js/core/document.js` and `inkwell-app/test_app_smoke.py` are modified (`git status`).
- [ ] `plans/README.md` status row updated for Plan 053.

## STOP conditions

Stop and report back (do not improvise) if:
- `setDocument` in `document.js` does not exist or has a different signature.
- `state.js` has removed or renamed `pageTextData` or `searchResults`.

## Maintenance notes

- When multi-tab document switching is performed, each tab session should preserve its own `pageTextData` dictionary in the tab state or re-fetch on activation.
