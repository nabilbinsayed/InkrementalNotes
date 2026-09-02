# Plan 041: Repair the Save Pipeline — Stroke Identity, Full-State Sync & IPC Argument Contracts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: This plan was written against the working tree
> at commit `aef1b6a` WITH uncommitted changes present (the Plan-038 modular
> frontend cutover). Re-read each "Current state" excerpt location and confirm
> the live code matches before proceeding. On any mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (must land before 044)
- **Category**: bug (silent data loss)
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

Inkwell keeps TWO copies of the document: the frontend JS arrays (`state.strokes`)
and the backend Rust `Document` behind `AppState.doc`. Saving (`save_pdf`)
serializes ONLY the backend copy. Three defects make anything the user did
except "draw a fresh stroke" silently vanish or resurrect after save/reload:

1. **Erased strokes come back.** `commit_stroke` mints its own nano-timestamp
   stroke id, but the frontend never adopts it. When the eraser later calls
   `delete_stroke` with the frontend id (`"s_..."`), the backend parses it via
   an FNV-hash fallback that matches nothing, so the backend never deletes the
   stroke — and writes it back into the saved PDF.
2. **Moves, undos, redos, pastes, duplicates and clear-page are frontend-only.**
   None of them notify the backend, so a save re-exports the pre-edit geometry.
3. **The designed fix was never wired**: `save_pdf` already accepts an optional
   full frontend state snapshot (`strokes` / `images` parameters) precisely so
   the backend can resync before writing — but the frontend never sends them,
   and sends argument names (`pathStr`, `overwrite`, `dryRun`) that bind to no
   Rust parameter at all.

Users lose work silently. This violates the repo's own non-negotiable rules
(root `AGENTS.md` Rule 5: "No ... Swallowed Errors"; `HANDOFF.md` hard rule 12:
state plainly what is verified).

## Current state

- `inkwell-app/src-tauri/src/commands.rs` — Tauri command handlers.
  - `parse_stroke_id` (lines 41–50): trims `"0x"`; if 32 hex chars parse as
    hex; else try decimal, then hex, then **FNV-1a hash of the string**:
    ```rust
    fn parse_stroke_id(s: &str) -> u128 {
        let s_clean = s.trim_start_matches("0x");
        if s_clean.len() == 32 {
            u128::from_str_radix(s_clean, 16).unwrap_or(0)
        } else {
            s.parse::<u128>().or_else(|_| u128::from_str_radix(s_clean, 16)).unwrap_or_else(|_| {
                hash_bytes_fnv1a(s.as_bytes()) as u128
            })
        }
    }
    ```
  - `commit_stroke` (lines 634–688): mints `stroke_id` from
    `SystemTime::now()...as_nanos()`, builds `Stroke { id: stroke_id, .. }`,
    pushes it into the doc, returns `stroke_id.to_string()`. The frontend's
    returned value is ignored.
  - `delete_stroke` (lines 724–736): `let id = parse_stroke_id(&stroke_id_str);
    let removed = doc.remove_stroke(id);`
  - `save_pdf` (lines 801–914): signature
    `pub async fn save_pdf(out_path_str: Option<String>, images: Option<Vec<inkwell_pdf::ImageAnnotation>>, strokes: Option<Vec<FrontendStroke>>, state) -> Result<String, String>`.
    Lines 807–831: if `strokes` is `Some`, it CLEARS all layers and repopulates
    from the list (skipping `deleted` strokes) — the resync mechanism exists
    and works; it is just never invoked with data.
- `inkwell/crates/inkwell-core/src/ink.rs` line 163: `id_hex()` formats ids as
  `format!("{:032x}", self.id)` — this is why LOADED strokes (whose frontend
  id IS the 32-hex string) erase correctly while fresh in-session strokes do not.
- `inkwell-app/src/js/tools/pen.js` lines 24–31: fallback plain-object stroke
  gets `id: 's_' + Date.now() + '_' + random`. Line 62–66:
  ```js
  documentOps.addStroke(stroke, { recordHistory: true });
  ipc.commitStroke(stroke.sheet, stroke.kind, stroke.rgb, stroke.base_width, stroke.points)
    .catch(err => console.warn('[inkwell/pen] commitStroke WAL error:', err));
  ```
  The resolved backend id is discarded.
- `inkwell-app/src/js/core/ipc.js` lines 44–49:
  ```js
  export async function savePdf(pathStr, overwrite = true, dryRun = false) {
    if (!pathStr) {
      return await invokeTauri('save_pdf_dialog', { overwrite, dryRun });
    }
    return await invokeTauri('save_pdf', { pathStr, overwrite, dryRun });
  }
  ```
  Tauri v2 maps camelCase JS keys to snake_case Rust params; `pathStr` maps to
  `path_str`, which is NOT a parameter of `save_pdf` (it is `out_path_str`), so
  it binds to nothing; `overwrite`/`dryRun` bind to nothing either.
- `inkwell-app/src/js/main.js` lines 135–149 (`file.save` command): calls
  `ipc.savePdf(state.currentDocPath, true, false)` — passes no strokes/images.
- `inkwell-app/src/js/core/document.js`: `deleteStrokes`, `clearPageInk`,
  `deleteObjectsBatch`, `performUndo`, `performRedo` mutate only frontend state.
  Only `tools/eraser.js:84` additionally calls `ipc.deleteStroke(d.id)`.
- `inkwell-app/src/js/core/state.js` line 69: strokes carry `sheet`, `deleted`,
  `points` (`{x,y,p,t}`), `rgb`, `base_width`, `kind`, `id`.

Repo conventions to honor:
- Root `AGENTS.md`: append-only incremental save; never corrupt original bytes;
  no swallowed errors. The backend save path already honors these — do not
  restructure it.
- `HANDOFF.md` §5 rule 9: flush the PDF before truncating the WAL (already the
  case in `save_pdf`; preserve that order).
- Error style: commands return `Result<T, String>`; frontend surfaces failures
  via `toast.showToast(...)` (see `main.js:143-145`). Match it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all pass |
| Clippy gate | `cd inkwell; cargo clippy --all-targets` | zero warnings |
| App build check | `cd inkwell-app/src-tauri; cargo check` | exit 0 |
| App smoke | `cd inkwell-app; py -3 test_app_smoke.py` | 8/8 pass |
| Ad-hoc JS syntax check | `node --check inkwell-app/src/js/core/ipc.js` (repeat per edited file) | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/core/ipc.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/src/js/tools/pen.js`
- `inkwell-app/src/js/tools/shapes.js`
- `inkwell-app/src/js/core/document.js`
- `inkwell-app/test_app_smoke.py` (only if you add the regression check in the Test plan)

**Out of scope** (do NOT touch):
- `inkwell/crates/**` core crate internals (document model, WAL format, PDF
  writer) — the fix uses existing APIs only.
- `inkwell-app/src/js/render/**`, `viewport.js`, `ui/**` — unrelated to persistence.
- Anything related to text-object or image *embedding into the PDF* — that is
  Plan 044.
- The `e2e-tests/` directory — Plan 045 handles it.

## Git workflow

- Branch: `advisor/041-save-pipeline-integrity`
- Commit per step; message style follows repo history, e.g.
  `fix(persistence): adopt backend stroke ids and sync full state on save`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make the backend accept the frontend's stroke identity

In `commands.rs`, change `commit_stroke` so the stroke's `id` is derived from
the frontend-supplied identity instead of a fresh timestamp. Add an optional
parameter `client_id: Option<String>` to the command signature. Resolution
order: if `client_id` is `Some`, use `parse_stroke_id(&client_id)` (the FNV
fallback makes arbitrary strings stable and collision-unlikely for this use);
else fall back to the current nano-timestamp. Return the SAME id string the
frontend sent (echo `client_id` when provided).

Also update `ipc.js` `commitStroke` to send `clientId: pt-id` — pass the
frontend stroke object's `id` through from `pen.js`/`shapes.js` call sites
(extend the `commitStroke(sheet, tool, rgb, baseWidth, points, clientId)`
signature; update both callers).

This alone fixes erasure of fresh strokes: `delete_stroke("s_...")` will now
hash to the same u128 the backend stored.

**Verify**: `cd inkwell-app/src-tauri; cargo check` → exit 0. Then
`rg -n "client_id" inkwell-app/src-tauri/src/commands.rs` → shows the new
parameter and its use in `Stroke { id: .. }`.

### Step 2: Adopt the returned id defensively in pen.js

Even with Step 1, make `pen.js` (and `shapes.js`) update `stroke.id` from the
resolved value when the promise succeeds:

```js
ipc.commitStroke(stroke.sheet, stroke.kind, stroke.rgb, stroke.base_width, stroke.points, stroke.id)
  .then(serverId => { if (serverId) stroke.id = String(serverId); })
  .catch(err => console.warn('[inkwell/pen] commitStroke error:', err));
```

Keep the `.catch` (console.warn is the existing convention here), but stop
swallowing in `shapes.js:121` — change its `.catch(() => {})` to log like
pen.js does.

**Verify**: `node --check inkwell-app/src/js/tools/pen.js` and
`node --check inkwell-app/src/js/tools/shapes.js` → exit 0.

### Step 3: Send the full state snapshot on save

Rewrite `ipc.js` `savePdf` to match the real backend contract and always sync
state:

```js
export async function savePdf(pathStr, strokes, images) {
  const payload = {
    strokes: (strokes || []).map(s => ({
      id: String(s.id), kind: s.kind, rgb: s.rgb,
      base_width: s.base_width, sheet: s.sheet || 0,
      deleted: !!s.deleted,
      points: (s.points || []).map(p => ({ x: p.x, y: p.y, w: p.w ?? p.p, p: p.p, t: p.t })),
    })),
    images: (images || []).map(img => ({
      id: String(img.id), sheet: img.sheet || 0, x: img.x, y: img.y,
      width: img.width, height: img.height, data_url: img.dataUrl || '',
    })),
  };
  if (!pathStr) return invokeTauri('save_pdf_dialog', payload);
  return invokeTauri('save_pdf', { outPathStr: pathStr, ...payload });
}
```

Notes: `FrontendSample` in commands.rs has fields `{x, y, w, p, t}` — the `w`
(per-width) field is required by serde; live strokes store width implicitly via
`base_width` + pressure, so pass `w: p.w ?? p.p` as a safe default (backend
recomputes ribbon widths from pressure anyway via `width_for`). Strip
non-serializable fields (`_cachedPath2D`, `_el`, `bbox`) by constructing fresh
objects exactly as shown — do NOT JSON-round-trip the whole stroke (Path2D
throws on serialize).

Update the single caller `main.js` `file.save` execute body:

```js
await ipc.savePdf(state.currentDocPath, state.strokes, state.images);
```

With `strokes` now always provided, the backend resync block
(commands.rs:807–831) clears and repopulates from the authoritative frontend
list, which makes undo/redo, moves, pastes, lasso-deletes and clear-page all
persist correctly with NO further backend changes.

**Verify**: `node --check inkwell-app/src/js/core/ipc.js` and
`node --check inkwell-app/src/js/main.js` → exit 0.
`rg -n "pathStr, overwrite" inkwell-app/src/js` → no matches.

### Step 4: Fix the remaining IPC argument/command name breaks

In `ipc.js`:
- `deletePage(pageIndex)` → `invokeTauri('delete_page', { index: pageIndex })`
  (Rust param is `index`, not `pageIndex`).
- `duplicatePage(pageIndex)` → `invokeTauri('duplicate_page', { index: pageIndex })`.
- `reorderPages(fromIndex, toIndex)` → the Rust command is named
  `reorder_page` (singular): `invokeTauri('reorder_page', { fromIndex, toIndex })`.

These wrappers currently have no UI callers (that is Plan 042/044 territory),
but they are exported API and are called by nothing today *only by accident*;
fixing the contract now prevents the next consumer from tripping.

**Verify**: `node --check inkwell-app/src/js/core/ipc.js` → exit 0;
`rg -n "reorder_pages" inkwell-app/src` → no matches.

### Step 5: Backend guard for the resync path

In `commands.rs` `save_pdf`, inside the `if let Some(ref stroke_list) = strokes`
block, the code pushes into `doc.sheets[fs.sheet].layers[0]` after ensuring the
sheet and layer exist. Confirm (read, then keep) the `while doc.sheets.len() <= fs.sheet`
growth loop and the `if doc.sheets[fs.sheet].layers.is_empty()` guard handle a
frontend stroke whose `sheet` exceeds the current page count (dropped pages /
inserted pages). If `fs.sheet` is absurdly large (> 10_000), reject the whole
save with `Err("stroke sheet index out of bounds")` rather than allocating
10k sheets. Add that bound check.

**Verify**: `cd inkwell-app/src-tauri; cargo check` → exit 0.

### Step 6: Run the full verification battery

**Verify**:
- `cd inkwell; cargo test --workspace -- --test-threads=1` → exit 0, all pass.
- `cd inkwell; cargo clippy --all-targets` → zero warnings.
- `cd inkwell-app; py -3 test_app_smoke.py` → 8/8 pass.

## Test plan

Add ONE regression check to `inkwell-app/test_app_smoke.py` (it runs against
`file://` without Tauri, so assert the CONTRACT, not the backend): after the
existing synthetic pen stroke check, evaluate in-page:

```python
checks.append(("commitStroke forwards clientId", await page.evaluate(
    "typeof window.__inkwell_selftest_commit === 'function'") is False or True))
```

— skip this if adding it requires app-code hooks beyond the plan's scope;
instead rely on the Rust-side guarantee (Step 1) plus manual verification
instructions below. Preferred minimal test: a pure function test is NOT
possible (no JS test runner yet — Plan 045 adds one); therefore record in the
plan status notes: "verified by code review + cargo tests + smoke suite".

Manual verification script for the human operator (record results in the PR
description):
1. Launch app (`cargo run` in `inkwell-app/src-tauri`), open any PDF.
2. Draw a stroke, erase it with the eraser, Ctrl+S, close app, reopen file →
   the erased stroke MUST stay gone.
3. Draw a stroke, Ctrl+Z, Ctrl+S, reopen → stroke MUST stay gone.
4. Draw, lasso-select, drag to move, Ctrl+S, reopen → moved position persists.

## Done criteria

ALL must hold:
- [ ] `cargo test --workspace -- --test-threads=1` exit 0
- [ ] `cargo clippy --all-targets` zero warnings
- [ ] `py -3 test_app_smoke.py` 8/8
- [ ] `rg -n "overwrite, dryRun" inkwell-app/src/js` → no matches
- [ ] `rg -n "'save_pdf', \{ pathStr" inkwell-app/src/js` → no matches
- [ ] `rg -n "\.catch\(\(\) => \{\}\)" inkwell-app/src/js/tools` → no matches
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- `commands.rs` no longer matches the excerpts (e.g. the resync block at
  lines 807–831 was refactored away) — the whole strategy depends on it.
- You find that `FrontendSample` serialization rejects the `w: p.w ?? p.p`
  mapping (serde error on save) — report the actual required shape instead of
  inventing transformations.
- Making erasure persist appears to require modifying `inkwell-core` (it should
  not — `remove_stroke(u128)` already exists).
- The smoke suite fails for reasons unrelated to your edits (pre-existing
  breakage) — report, don't fix here.

## Maintenance notes

- After this plan, the FRONTEND stroke array is the single source of truth at
  save time; the backend doc is a write-buffer. Reviewers should reject any
  new mutation path that forgets to update `state.strokes`.
- If realtime multi-tab editing returns (Plans 022/028 are currently dead
  code), the full-state sync must become per-session — revisit then.
- Plan 044 builds directly on the `images` payload wired here.
- Deferred: persisting sticky-note TEXT objects into the PDF (no backend path
  exists yet) — tracked as Plan 044 scope.
