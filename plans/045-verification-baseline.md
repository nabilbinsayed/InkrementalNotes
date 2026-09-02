# Plan 045: Real Verification Baseline — Honest Smoke Suite, Dead E2E Retirement, CI & Docs Truthing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: Written against working tree at `aef1b6a`.
> This plan DEPENDS on 041–043 having landed (it asserts their fixed
> behavior). If those plans are not DONE per `plans/README.md`, STOP.

## Status

- **Priority**: P1 (execution order: after 041–043)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/041, plans/042, plans/043
- **Category**: tests / dx / docs
- **Planned at**: commit `aef1b6a`, 2026-08-21

## Why this matters

The repo's only automated check on the real frontend is a smoke suite that
passes while half the app is broken: it clicks tool IDs that do not exist in
the DOM (`#toolPen` etc.) inside `if btn.count() > 0` guards that silently skip,
runs without any Tauri backend stub so every IPC path no-ops, and asserts only
"no console errors". Meanwhile four plan documents cite a 272-test e2e gate
that now crashes on import (it asserts the deleted `app.js` exists), README
claims "100% test coverage" and "48 tests" (actual count: ~70), and the
advertised verification story points at the M0 prototype instead of the app.
The zoom/text-selection regressions shipped precisely because nothing could
catch them. This plan makes "green" mean something again.

## Current state

- `inkwell-app/test_app_smoke.py` — 8 checks. Key defects:
  - Line ~47–51: loops over `#tool{Pen,Highlighter,...}` — no such IDs exist
    (real dock buttons are `#btnDockPen` etc., see index.html:620–650); the
    `count() > 0` guard skips every click; then asserts success.
  - Runs plain Chromium against `file://` (lines ~9, 18–27);
    `core/ipc.js getInvoke()` returns null without Tauri globals, so all
    backend calls silently return null.
  - Pen check (~line 87) asserts only absence of errors — never inspects
    `state.strokes` or canvas pixels.
- `inkwell-m0/test_smoke.py` — 18 checks against the PROTOTYPE page
  (`inkwell-m0/src/index.html`), honestly documented in its own docstring;
  README.md:141-143 presents it as THE Playwright suite.
- `e2e-tests/` — `test_tier1_features.py:52-53` asserts
  `app_js_path.exists()` for `inkwell-app/src/js/app.js` (deleted by Plan 038)
  → suite cannot run. `harness.py` implements a Python mock of the backend;
  most tier tests exercise that mock. `run_all.py:22-26` advertises 272 tests.
  Plans 032/033/035/036 each cite `run_all.py → 272/272` as a gate.
- `README.md` §Verification (lines 132–148): claims "100% test coverage"
  (line 134), "48 tests" (line 137), m0 as the Playwright suite (141–143).
  Actual: `rg -c "#\[test\]" inkwell/crates` counts ~70 across core+pdf.
- `.github/workflows/build.yml` — EXISTS but is UNTRACKED in git
  (`git status` shows `?? .github/`); runs only npm install + tauri build in
  three OS jobs; no cargo test/clippy/pytest steps.
- `inkwell-app/package.json` line 9: `"test": "python -m pytest test_app_smoke.py"`
  — but the file is a top-level script ending in `sys.exit`, not a pytest
  module; collection-time SystemExit produces confusing failures.
- No eslint/prettier/tsconfig anywhere; devDependencies contain only
  `@tauri-apps/cli`.
- Repo conventions: Python scripts run with `py -3` on Windows (see AGENTS.md
  verification table); tests print `=== Tn Name ===` sections and end with
  `N/N checks passed`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| App smoke | `cd inkwell-app; py -3 test_app_smoke.py` | new total N/N pass |
| Rust tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0 |
| Clippy | `cd inkwell; cargo clippy --all-targets` | zero warnings |
| Playwright browsers | `py -3 -m playwright install chromium` | exit 0 (already installed on this machine) |

## Scope

**In scope**:
- `inkwell-app/test_app_smoke.py` (rewrite)
- `inkwell-app/package.json` (fix test script; add lint/typecheck scripts)
- `e2e-tests/README.md` (NEW — deprecation notice) and deletion of the four
  `test_tier*.py` files + `harness.py` + `run_all.py`
- `README.md` (§Verification rewrite)
- `AGENTS.md` (verification table row for the real app suite)
- `plans/032,033,035,036` — add one-line historical note at top of each:
  "e2e tier gate retired by Plan 045; suites tested a Python mock."
- `.github/workflows/build.yml` (add verify job) — file already exists untracked
- `devlog` none.

**Out of scope** (do NOT touch):
- Any file under `inkwell-app/src/js/**` or `src-tauri/**` — product code is
  frozen in this plan. If a test reveals a NEW bug, record it in the PR and
  stop; do not fix here.
- `inkwell-m0/**` — prototype stays as-is (only README labeling changes).
- Introducing vitest/jest unit infrastructure — deferred (Maintenance notes).

## Git workflow

- Branch: `advisor/045-verification-baseline`
- Commit per step; style: `test(app): rewrite smoke suite with real assertions`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Rewrite the app smoke suite with real selectors and assertions

Rewrite `inkwell-app/test_app_smoke.py` keeping its section-print format.
Requirements:

1. Keep `file://` boot (Tauri stub comes in Step 2).
2. T2 Tool switching: click REAL buttons `#btnDockPen`, `#btnDockHighlighter`,
   `#btnDockEraser`, `#btnDockLasso`, `#btnDockTextSelect`, `#btnDockShapes`,
   `#btnDockText`, `#btnDockLaser`, `#btnDockPan`. After each click evaluate
   `state.activeTool` via `page.evaluate("import('./js/core/state.js').then(m => m.state.activeTool)")`
   (ES module import works from file:// because main.js already does it) and
   assert it equals the expected tool id. FAIL if a locator matches 0 elements
   (replace every silent-skip guard with an explicit `expect(count == 1)`).
3. T4 Pen pipeline: after the synthetic CDP pen stroke (keep the existing
   approach), assert `state.strokes.length >= 1` AND sample the dry canvas:
   `page.evaluate("...getContexts().dctx.getImageData(...)")` is awkward across
   modules — instead expose nothing new; use
   `page.evaluate("document.getElementById('dry').toDataURL().length > 2000")`
   as a cheap "pixels exist" proxy, plus the strokes-length assertion.
4. T5 Zoom regression (new): click `#btnZoomIn`; assert no pageerror fired and
   `#zoomLevelDisplay` textContent changed from "100%" OR stayed consistent
   with `viewport.zoom` read via evaluate. Assert clicking did NOT produce a
   console error (collect pageerror events).
5. T6 Text selection activation (new): click `#btnDockTextSelect`; assert
   `state.activeTool === 'textSelect'`.
6. Console hygiene: keep zero-error assertion; RELAX zero-WARNING to
   "no warnings matching /\[inkwell\//"" (Chromium deprecations must not fail
   the suite).
7. Replace fixed `wait_for_timeout` sleeps with
   `page.wait_for_function(...)` polling wherever a sleep was load-bearing.
8. Write NO screenshot into the repo (delete that step).

**Verify**: `cd inkwell-app; py -3 test_app_smoke.py` → all checks pass, and
the output shows the NEW check names. Deliberately confirm T4/T5/T6 names appear.

### Step 2: Add a minimal Tauri invoke stub so IPC paths execute

At the top of the suite's page-load routine, add an init script:

```python
page.add_init_script("""
window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
  if (window.__inkwell_stub && window.__inkwell_stub[cmd]) return window.__inkwell_stub[cmd](args);
  return null; } };
window.__TAURI__ = { core: { invoke: window.__TAURI_INTERNALS__.invoke } };
""")
```

Then set `window.__inkwell_stub.render_tile` to return a small solid-RGBA
ArrayBuffer-backed array (e.g. 16x16x4 of 128) and `get_page_text_data` to
return `{page_index:0, text:'a b c', lines:[], chars:[], spans:[]}` so tile
and text paths execute their JS-side handling. Keep the stub dumb — it exists
to exercise frontend branches, not to fake the backend.

**Verify**: rerun suite → still green; add one assertion that
`getInvoke()` resolved non-null: `page.evaluate("!!window.__TAURI__") === true`.

### Step 3: Retire the dead e2e tier suites

- Delete `e2e-tests/test_tier1_features.py`, `test_tier2_boundaries.py`,
  `test_tier3_pairwise.py`, `test_tier4_workloads.py`, `harness.py`,
  `run_all.py`.
- Create `e2e-tests/README.md`: "The former Python tier suites (272 checks)
  exercised a Python re-implementation of the backend, not the product, and
  referenced the deleted monolithic app.js. Retired 2026-08 by Plan 045.
  Product verification lives in `inkwell-app/test_app_smoke.py` (frontend)
  and `cargo test --workspace` (backend). Pure-math boundary coverage already
  exists as Rust tests in `inkwell/crates/*`."

**Verify**: `Get-ChildItem e2e-tests` → only README.md remains;
`rg -rn "272" plans/032 plans/033 plans/035 plans/036` then add the one-line
historical note under each plan's title quoting its retirement.

### Step 4: Fix package.json scripts

```json
"scripts": {
  "dev": "tauri dev",
  "build": "tauri build",
  "test": "py -3 test_app_smoke.py",
  "lint:ci": "node --check src/js/main.js && node --check src/js/core/ipc.js"
}
```

(`lint:ci` is intentionally minimal syntax checking until a real linter lands —
see Maintenance notes. Use `&&` chaining; this script runs under cmd/npm which
supports it.)

**Verify**: `cd inkwell-app; npm test` → suite runs and passes (not a pytest
collection error).

### Step 5: Truthing in README + AGENTS.md + CI

- README §Verification: replace with three rows — Rust core (`cargo test`,
  "~70 tests" — run once and paste the exact number from the summary line),
  production frontend (`cd inkwell-app; py -3 test_app_smoke.py`), M0
  prototype (`cd inkwell-m0; py -3 test_smoke.py`, labeled "prototype only").
  Delete the "100% test coverage" sentence entirely.
- AGENTS.md verification table: add the app-suite row; relabel the m0 row.
- `.github/workflows/build.yml`: add a `verify` job (ubuntu-latest is fine for
  cargo; use `dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2`) running
  `cargo test --workspace -- --test-threads=1` and
  `cargo clippy --all-targets -- -D warnings` in `inkwell/`, plus a
  windows-latest job step running the two python suites with
  `pip install playwright pytest && playwright install chromium`. Ensure the
  whole `.github/` directory gets committed with this plan's branch.

**Verify**: `git status` shows `.github/` staged; YAML parses
(`py -3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build.yml'))"` → exit 0).

## Test plan

This plan IS tests. New coverage added: tool switching (9 tools, state
assertions), stroke-commit state+pixel assertions, zoom click regression,
text-select activation regression, Tauri-stubbed IPC branch execution.

## Done criteria

ALL must hold:
- [ ] `cd inkwell-app; py -3 test_app_smoke.py` → ≥12 checks, all pass, including named zoom & text-select regression checks
- [ ] `npm test` in inkwell-app runs the suite directly
- [ ] `e2e-tests/` contains only README.md
- [ ] `rg -n "100% test coverage" README.md` → no matches
- [ ] `git ls-files .github` → non-empty (CI committed)
- [ ] Rust battery still green (nothing in product code touched, but run it)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:
- Any Step-1 assertion fails against the CURRENT tree in a way that indicates
  Plans 041–043 did not actually land (e.g. `zoomIn` still missing).
- ES-module dynamic import from `file://` fails in Playwright (module loading
  changed) — report exact error; do not switch the suite to a bundler.
- Deleting e2e-tests reveals a dependent script outside the deleted set
  (`rg -l "e2e-tests" --glob !plans` finds a consumer).

## Maintenance notes

- Next DX step (deferred deliberately): introduce `vitest` or bare
  `node --test` units for `core/commands.js` shortcut normalisation,
  `workspace/text-selection.js` grouping, and `render/ink.js` filter math;
  wire into `npm test`. Do it AFTER the smoke baseline is stable.
- A real linter (eslint with `no-undef` + `checkJs`) would have caught the
  zoomIn bug class statically; propose as follow-up once CI is green.
- Reviewer focus: the Tauri stub must stay obviously fake (name
  `__inkwell_stub`) so nobody mistakes it for an integration suite.
