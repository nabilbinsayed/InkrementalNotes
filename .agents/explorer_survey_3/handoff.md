# Performance, UI/UX, and Testing Infrastructure Survey Report (R3 Survey)

## 1. Observation

### 1.1 Test Suite & Verification Commands
Direct execution of all test suites across the repository yielded the following results:
- **`inkwell-app/test_app_smoke.py`**:
  ```bash
  uv run --with playwright python3 test_app_smoke.py
  ```
  Result: **20/20 checks passed** (Exit code 0).
  - T1 Boot & ES Module Loading: page loads with no JS errors, triple canvases (`tiles`, `dry`, `wet`) initialized, stage element mounted, Tauri invoke stub connected.
  - T2 Tool Switching & State Machine: all 9 dock tools toggle with correct state machine mapping.
  - T3 Navigation Rail & Drawer Panels: rail buttons (`thumbnails`, `outline`, `search`, `docInfo`) toggle without exceptions.
  - T4 Synthetic Pen Input Pipeline: pen stroke committed to document state (`strokes=1`), dry canvas composited ink bitmap.
  - T5 Zoom Controls: zoom in/out updates zoom percentage readout (`initial=66% zoomed=82% restored=66%`).
  - T6 Text Toolchain: text select tool, popover element, inline sticky note editor and textarea mounted.
  - T7 Console & Warning Hygiene: 0 console errors, 0 internal warnings.

- **`inkwell-m0/test_smoke.py`**:
  ```bash
  uv run --with playwright python3 test_smoke.py
  ```
  Result: **18/18 checks passed** (Exit code 0).
  - Verified M0 latency baseline, 420 samples captured over CDP synthetic pen event stream, 195 analogue pressure levels (max 0.950), pressure-variable stroke width (0.83–3.07px), wet layer cleared upon commit, dry layer containing 3,959 inked pixels, coalesced pointer toggle state flip/restore, and export schema compliance (`['id', 'kind', 'rgb', 'base_width', 'samples']`).

- **`inkwell/` Rust Workspace Tests**:
  ```bash
  cargo test --workspace -- --test-threads=1
  ```
  Result: **72/72 tests passed** (Exit code 0, 0 failed, 0 ignored).
  - `inkwell_core`: adversarial security (8), geometry (6), integration (26), spatial (6), tiles (14).
  - `inkwell_pdf`: adversarial security (3), integration (8), doc-tests (1).

- **`e2e-tests/`**:
  - `e2e-tests/README.md` documents that legacy Python tier mock suites (which tested a standalone mock and referenced the deleted monolithic `app.js`) were retired in Plan 045 in favor of `inkwell-app/test_app_smoke.py` and the Rust test suite.

---

### 1.2 Rendering Architecture & 60+ FPS Pipeline
Direct observation of `inkwell-app/src/js/render/compositor.js`, `tiles.js`, `overlays.js`, `templates.js`, `ink.js`, and `viewport.js`:
- **Triple Canvas Pipeline** (`index.html:592-594`, `compositor.js:13-31`):
  1. `#tiles`: Vector PDF pages rendered on-demand per LOD tile via PDFium (`tiles.js`). Rendered with `alpha: true, desynchronized: true`.
  2. `#dry`: Composited committed vector ink strokes, embedded images, direct in-place text objects, persistent text selection bounding highlights, and search match highlights (`compositor.js:161-252`).
  3. `#wet`: Active inking layer (`tool-pen`, `tool-highlighter`), geometric shape preview (`overlays.js:155-185`), ephemeral laser pointer trails (`overlays.js:187-200`), and lasso polygon / 8-handle transform bounding box (`overlays.js:90-153`).
- **Path2D Caching & Viewport Bounding Box Culling** (`ink.js:130-136, 211-260`, `compositor.js:219-239`):
  - In `ink.js:211-260`, `getPath2D(stroke)` compiles Chaikin-subdivided midpoint quadratic spline segments into a reusable `Path2D` object.
  - In `compositor.js:226-236`, `redrawAll()` culls strokes using `stroke.bbox`:
    ```javascript
    if (s.bbox) {
      const margin = s.base_width || 4;
      if (
        s.bbox[2] < -margin ||
        s.bbox[0] > pageW + margin ||
        s.bbox[3] < -margin ||
        s.bbox[1] > pageH + margin
      ) {
        continue; // Bbox lies completely outside visible page bounds
      }
    }
    ```
  - In `main.js:79-95`, post-load warm-up worker calculates `Path2D` and `bbox` in 8ms non-blocking slices.
- **Incremental Wet Inking** (`pen.js:102-155`):
  - During drawing, incoming points do not clear and repaint the wet canvas from scratch. `consumeFilteredPoint` issues incremental `drawSegment(wctx, prev, pt)` calls directly to the GPU context in O(1) time per event.

---

### 1.3 Inking Latency & Sample Ingestion
- In `main.js:742-773`, pointer move listeners prioritize `'pointerrawupdate'` when supported, falling back to `'pointermove'`.
- `e.getCoalescedEvents()` is extracted and looped (`main.js:745-772`), ensuring high-rate digitizer samples (120Hz/144Hz/240Hz) are processed rather than dropped.
- Filtering chain (`ink.js:17-58`):
  - `OneEuro` filter (`minCutoff = 1.1`, `beta = 0.006`, `dCutoff = 1.0`) smooths jitter while eliminating lag on rapid directional changes.
  - `Streamline` spring lerp (`positionLerp = 0.45`, `pressureLerp = 0.35`) smooths high-frequency digitizer tremor while preserving the initial touchdown point exact.
  - Warmup pressure spike suppression (`ink.js:105-107`) clamps initial samples (`p = Math.min(p, 0.35)` for the first 2 points) to eliminate stylus contact pressure spikes.
  - Native Linux `evdev` stream (`tool-manager.js:19-45`, `ipc.js:218-237`) supports sub-millisecond tablet events directly via Tauri Channel.

---

### 1.4 UI/UX, Touch Targets & State Machine Audit
- **Touch Target Dimensions** (`styles.css`):
  - Compliant (>= 44x44px):
    - `.dock-btn`: `width: 44px; height: 44px; min-width: 44px; min-height: 44px;` (`styles.css:1309-1312`).
    - `.rail-btn`: `width: 44px; height: 44px; min-width: 44px; min-height: 44px;` (`styles.css:108-111`).
    - `.rail-logo-btn`: `width: 44px; height: 44px;` (`styles.css:74-75`).
  - Below Touch Target Guidelines (< 44x44px):
    - `.header-icon-btn`: `width: 32px; height: 32px;` (`styles.css:838-839`).
    - `.nav-cluster-btn`: `width: 32px; height: 32px;` (`styles.css:996-999`).
    - `.nav-cluster-btn.mini`: `width: 24px; height: 24px;` (`styles.css:1120-1121`).
    - `.tab-add-btn`: `width: 28px; height: 28px;` (`styles.css:957-960`).
    - `.tab-close`: `width: 18px; height: 18px;` (`styles.css:943-944`).
    - `.drawer-close-btn`: `width: 28px; height: 28px;` (`styles.css:202-203`).
    - `.zoom-dock-btn`: `width: 30px; height: 30px;` (`styles.css:1461-1464`).
    - `.bookmark-delete-btn`: `width: 24px; height: 24px;` (`styles.css:513-514`).
    - `.layer-visibility-btn`: `width: 24px; height: 24px;` (`styles.css:565-566`).
- **Focus States**:
  - `styles.css:2366-2369`:
    ```css
    button:focus-visible, .rail-btn:focus-visible, .dock-btn:focus-visible, .header-icon-btn:focus-visible, .doc-tab:focus-visible {
      outline: 2px solid #7C3AED;
      outline-offset: 2px;
    }
    ```
- **Glassmorphic Toast Notifications**:
  - `styles.css:2329-2364` and `ui/toast.js:8-32`: fixed bottom-right container, `backdrop-filter: blur(12px);`, color-coded status indicator borders (`#ef4444` error, `#10b981` success, `#f59e0b` warning, `#7C3AED` info), smooth enter/leave transitions, 3-second auto-dismissal.
- **Spacebar Interaction & Tool State Machine Flaw** (`tool-manager.js:92-125, 153-175`):
  - In `tool-manager.js:153-175`:
    ```javascript
    export function handleSpringKeyDown(key) {
      if (state.springKey) return;
      if (key === ' ' || key === 'Space') {
        state.springKey = 'space';
        state.prevTool = state.activeTool;
        setTool('pan');
      }
    }
    export function handleSpringKeyUp(key) {
      if (!state.springKey) return;
      if ((key === ' ' || key === 'Space') && state.springKey === 'space') {
        state.springKey = null;
        setTool(state.prevTool || 'pen');
      }
    }
    ```
  - In `tool-manager.js:92-125`: `setTool()` does not record a previous tool history (`state.previousActiveTool`) upon normal tool switching.
  - Result: Tapping spacebar simply enters pan on keydown and exits pan back to the same tool on keyup; it does NOT toggle between the two most recently used tools (e.g., Pen <-> Eraser).

---

### 1.5 Error Handling & Console Hygiene
- `main.js:118-126`: `friendlyError()` formats raw error strings and messages (e.g. file lock, permissions, empty selection) into clear user guidance.
- `core/state.js:80-87`: `warnDurability(msg)` emits user-visible warnings when WAL or filesystem journal writes encounter issues.
- `core/ipc.js`: All IPC calls have catch blocks with explicit error logging and `warnDurability` calls; no silent catch blocks or swallowed errors exist in the inking/saving paths.
- Console hygiene: Both Playwright test runs reported zero unhandled console errors or exceptions.

---

## 2. Logic Chain

1. **Test Verification**:
   - `test_app_smoke.py` (20/20 checks) and `test_smoke.py` (18/18 checks) alongside `cargo test --workspace` (72/72 tests) demonstrate that the core math, PDF parsing, WAL durability, and frontend component mounting are functionally intact and verified across both headless browser and native Rust layers.

2. **Rendering Performance**:
   - The separation of canvas concerns (`tiles` for raster PDF LOD, `dry` for static annotations, `wet` for active interaction) prevents expensive PDF tile re-rasterization during active drawing.
   - Using `desynchronized: true` and O(1) incremental segment rendering on the wet canvas allows touch/stylus inking to track digitizer events at display refresh rate without full-canvas clear latency.
   - For complex drawings, `Path2D` caching and AABB bbox viewport culling prevent re-computing spline outlines on every redraw.
   - However, during rapid panning/zooming over thousands of strokes, `redrawAll()` performs a linear array scan of `state.strokes` for the sheet. A spatial grid index (mirroring `crates/inkwell-core/src/spatial.rs`) on the client would reduce culling overhead from O(N) to O(log N + K).

3. **UI/UX & Spacebar Interaction Repair**:
   - Requirement R2 stipulates: "Tapping spacebar toggles immediately between the currently active tool and the previous tool; holding spacebar engages temporary pan mode while pressed."
   - Because `handleSpringKeyDown` sets `prevTool = activeTool` and switches immediately to `'pan'`, a tap (< 250ms) releases back to `prevTool` (the tool that was just active), effectively making spacebar a no-op tap.
   - Additionally, `setTool()` lacks previous-tool tracking (`state.lastUsedTool`).
   - Resolving this requires:
     1. In `setTool(newTool)`: When switching between primary tools (pen, highlighter, eraser, lasso, shapes, text, laser), save `state.lastUsedTool = currentTool`.
     2. In `handleSpringKeyDown(' ')`: Record `state.spaceDownTime = performance.now()`.
     3. In `handleSpringKeyUp(' ')`: If `performance.now() - state.spaceDownTime < 250`, switch to `state.lastUsedTool || 'pen'`; if `>= 250`, restore the tool that was active before spacebar was pressed.

4. **Touch Target Ergonomics**:
   - While primary dock tools and navigation rail buttons adhere strictly to the 44x44px touch guideline, secondary header icon buttons (32x32px), nav cluster buttons (32x32px), and zoom buttons (30x30px) fall short of the 44px minimum touch target size.
   - For desktop mice this is acceptable, but for stylus/touchscreen devices, expanding interactive hit areas via padding or transparent pseudo-elements (`::before` / `::after` min-width: 44px, min-height: 44px) will satisfy accessibility guidelines without disrupting visual density.

---

## 3. Caveats

1. **Hardware-dependent Inking Feel**: Headless Playwright tests (`test_app_smoke.py`, `test_smoke.py`) verify API execution and metric capture under simulated CDP event streams, but real-world stylus feel on physical 120Hz/240Hz digitizers (e.g. Wacom, Huion, Surface Pen) must be validated in manual runtime testing on Linux (`evdev`) and Windows (`PointerPoint`).
2. **Clippy Environment**: `cargo clippy` is not installed in the current Linux container environment (`which: no cargo-clippy`), although `cargo test` compiled all crates with zero warnings under debug/test profiles.
3. **Retired E2E Python Suite**: As confirmed in `e2e-tests/README.md`, the former 272-test Python tier was retired in Plan 045; test verification for the desktop app is now anchored in `inkwell-app/test_app_smoke.py` and `cargo test --workspace`.

---

## 4. Conclusion

1. **Performance State**: The rendering engine achieves 60+ FPS potential via its triple canvas architecture, desynchronized 2D contexts, incremental wet stroke rendering, and Path2D cached ribbon outlines.
2. **Key Tool Repair Items (R2)**:
   - Implement tap-vs-hold spacebar detection in `js/tools/tool-manager.js` (<250ms tap = toggle last two active tools; >=250ms hold = temporary pan mode).
   - Maintain `state.lastUsedTool` in `setTool()` across all primary tool switches.
3. **UI/UX Refinements (R3)**:
   - Enhance hit target areas on secondary buttons (`.header-icon-btn`, `.nav-cluster-btn`, `.zoom-dock-btn`) with touch-accessible hit boxes.
   - Maintain excellent focus ring visibility and glassmorphic toast notifications.
4. **Testing Infrastructure**: Robust smoke test infrastructure exists with 100% pass rates on `test_app_smoke.py` (20/20) and `test_smoke.py` (18/18).

---

## 5. Verification Method

To independently verify the survey results and performance pipeline:

1. **Run Desktop App Smoke Test**:
   ```bash
   cd /mnt/Work/Own\ Programs/InkWell/inkwell-app
   uv run --with playwright python3 test_app_smoke.py
   ```
   *Expected Outcome*: Exit 0, 20/20 checks passed.

2. **Run M0 Prototype Smoke Test**:
   ```bash
   cd /mnt/Work/Own\ Programs/InkWell/inkwell-m0
   uv run --with playwright python3 test_smoke.py
   ```
   *Expected Outcome*: Exit 0, 18/18 checks passed.

3. **Run Rust Workspace Unit and Integration Tests**:
   ```bash
   cd /mnt/Work/Own\ Programs/InkWell/inkwell
   cargo test --workspace -- --test-threads=1
   ```
   *Expected Outcome*: Exit 0, 72/72 tests passed.

4. **Inspect Key Source Locations**:
   - `inkwell-app/src/js/render/compositor.js` (lines 13-31, 161-252) — Triple canvas pipeline & Path2D redraw.
   - `inkwell-app/src/js/tools/pen.js` (lines 102-155) — Incremental O(1) wet segment rendering.
   - `inkwell-app/src/js/tools/tool-manager.js` (lines 92-125, 153-175) — Tool switching and spring key handling.
   - `inkwell-app/src/styles.css` (lines 1307-1324, 837-850, 2329-2364) — Touch targets, focus states, and toast styling.
