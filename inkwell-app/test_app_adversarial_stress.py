"""Adversarial Stress & Boundary Challenge Suite for InkWell Frontend.

Empirical verification of:
1. Spacebar rapid toggle stress, repeat events, input element isolation, and hold-to-pan invariants.
2. PDF Text Selection boundary cases (negative drag, multi-line span, word/line double/triple click expansion, empty selection).
3. Touch target hit-testing at subpixel/boundary coordinates for compact UI controls.
4. Extreme zoom levels, clamping thresholds, and split-pane coordinate invariants.
5. High-frequency random tool switching stress (100 transitions) and history tracking invariants.
6. Undo/redo state synchronization and canvas dry pipeline durability under mutation.
"""
import math, pathlib, random, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "src" / "index.html").as_uri()

errors, warnings = [], []
results = []

def check(name, cond, note=""):
    results.append(bool(cond))
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {name}" + (f"   {note}" if note else ""), flush=True)

with sync_playwright() as pw:
    b = pw.chromium.launch(
        headless=True,
        args=[
            "--allow-file-access-from-files",
            "--force-device-scale-factor=1",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage"
        ]
    )
    ctx = b.new_context(
        viewport={"width": 1360, "height": 860},
        permissions=["clipboard-read", "clipboard-write"]
    )
    pg = ctx.new_page()

    pg.add_init_script("""
    window.__inkwell_stub = {
      render_tile: async (args) => {
        const rect = (args && args.rect) || [0, 0, 256, 256];
        const px = (args && args.px) || 256;
        const rw = rect[2] - rect[0];
        const rh = rect[3] - rect[1];
        const scale = px / Math.max(rw, rh);
        const tileW = Math.round(rw * scale) || 1;
        const tileH = Math.round(rh * scale) || 1;
        return new Array(tileW * tileH * 4).fill(128);
      },
      get_page_text_data: async (args) => ({
        page_index: 0,
        text: 'Hello InkWell\\nSecond Line of PDF Text',
        lines: [
          {
            line_index: 0,
            rect: [50, 50, 200, 70],
            text: 'Hello InkWell',
            chars: [
              { c: 'H', char_index: 0, line_index: 0, rect: [50, 50, 62, 70] },
              { c: 'e', char_index: 1, line_index: 0, rect: [62, 50, 74, 70] },
              { c: 'l', char_index: 2, line_index: 0, rect: [74, 50, 80, 70] },
              { c: 'l', char_index: 3, line_index: 0, rect: [80, 50, 86, 70] },
              { c: 'o', char_index: 4, line_index: 0, rect: [86, 50, 98, 70] },
              { c: ' ', char_index: 5, line_index: 0, rect: [98, 50, 104, 70] },
              { c: 'I', char_index: 6, line_index: 0, rect: [104, 50, 110, 70] },
              { c: 'n', char_index: 7, line_index: 0, rect: [110, 50, 122, 70] },
              { c: 'k', char_index: 8, line_index: 0, rect: [122, 50, 134, 70] },
              { c: 'W', char_index: 9, line_index: 0, rect: [134, 50, 150, 70] },
              { c: 'e', char_index: 10, line_index: 0, rect: [150, 50, 162, 70] },
              { c: 'l', char_index: 11, line_index: 0, rect: [162, 50, 168, 70] },
              { c: 'l', char_index: 12, line_index: 0, rect: [168, 50, 174, 70] }
            ]
          },
          {
            line_index: 1,
            rect: [50, 80, 250, 100],
            text: 'Second Line of PDF Text',
            chars: [
              { c: 'S', char_index: 14, line_index: 1, rect: [50, 80, 62, 100] },
              { c: 'e', char_index: 15, line_index: 1, rect: [62, 80, 74, 100] },
              { c: 'c', char_index: 16, line_index: 1, rect: [74, 80, 86, 100] },
              { c: 'o', char_index: 17, line_index: 1, rect: [86, 80, 98, 100] },
              { c: 'n', char_index: 18, line_index: 1, rect: [98, 80, 110, 100] },
              { c: 'd', char_index: 19, line_index: 1, rect: [110, 80, 122, 100] }
            ]
          }
        ],
        chars: [
          { c: 'H', char_index: 0, line_index: 0, rect: [50, 50, 62, 70] },
          { c: 'e', char_index: 1, line_index: 0, rect: [62, 50, 74, 70] },
          { c: 'l', char_index: 2, line_index: 0, rect: [74, 50, 80, 70] },
          { c: 'l', char_index: 3, line_index: 0, rect: [80, 50, 86, 70] },
          { c: 'o', char_index: 4, line_index: 0, rect: [86, 50, 98, 70] },
          { c: ' ', char_index: 5, line_index: 0, rect: [98, 50, 104, 70] },
          { c: 'I', char_index: 6, line_index: 0, rect: [104, 50, 110, 70] },
          { c: 'n', char_index: 7, line_index: 0, rect: [110, 50, 122, 70] },
          { c: 'k', char_index: 8, line_index: 0, rect: [122, 50, 134, 70] },
          { c: 'W', char_index: 9, line_index: 0, rect: [134, 50, 150, 70] },
          { c: 'e', char_index: 10, line_index: 0, rect: [150, 50, 162, 70] },
          { c: 'l', char_index: 11, line_index: 0, rect: [162, 50, 168, 70] },
          { c: 'l', char_index: 12, line_index: 0, rect: [168, 50, 174, 70] },
          { c: ' ', char_index: 13, line_index: 0, rect: [174, 50, 180, 70] },
          { c: 'S', char_index: 14, line_index: 1, rect: [50, 80, 62, 100] },
          { c: 'e', char_index: 15, line_index: 1, rect: [62, 80, 74, 100] },
          { c: 'c', char_index: 16, line_index: 1, rect: [74, 80, 86, 100] },
          { c: 'o', char_index: 17, line_index: 1, rect: [86, 80, 98, 100] },
          { c: 'n', char_index: 18, line_index: 1, rect: [98, 80, 110, 100] },
          { c: 'd', char_index: 19, line_index: 1, rect: [110, 80, 122, 100] }
        ],
        spans: []
      }),
      commit_stroke: async (args) => (args && args.clientId) ? String(args.clientId) : 's_stub_123',
      delete_stroke: async (args) => true,
      open_pdf: async (args) => ({
        page_infos: [
          { page_index: 0, width_pt: 595.0, height_pt: 842.0 },
          { page_index: 1, width_pt: 595.0, height_pt: 842.0 }
        ],
        outline: []
      }),
      create_blank_document: async (args) => ({
        page_infos: [
          { page_index: 0, width_pt: 595.0, height_pt: 842.0 },
          { page_index: 1, width_pt: 595.0, height_pt: 842.0 }
        ],
        outline: []
      }),
      search_pdf: async (args) => [],
      render_raster: async () => new Array(64 * 64 * 4).fill(255),
      get_document_outline: async () => [],
      wal_flush: async () => true,
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (window.__inkwell_stub && typeof window.__inkwell_stub[cmd] === 'function') {
          return await window.__inkwell_stub[cmd](args);
        }
        return null;
      }
    };
    window.__TAURI__ = {
      core: { invoke: window.__TAURI_INTERNALS__.invoke }
    };
    """)

    pg.on("console", lambda m: (errors if m.type == "error" else
                                warnings if m.type == "warning" else []).append(m.text))
    pg.on("pageerror", lambda e: errors.append(str(e)))

    print("\n=======================================================", flush=True)
    print("  ADVERSARIAL STRESS TEST HARNESS — INKWELL FRONTEND  ", flush=True)
    print("=======================================================", flush=True)

    pg.goto(URL)
    pg.wait_for_timeout(500)

    welcome_btn = pg.locator("#btnWelcomeNewNote")
    if welcome_btn.count() > 0 and welcome_btn.is_visible():
        welcome_btn.click()
        pg.wait_for_timeout(300)

    # -------------------------------------------------------------
    # STRESS 1: Spacebar Rapid Fuzzing, Repeats & Focus Isolation
    # -------------------------------------------------------------
    print("\n--- [S1] Spacebar Rapid Fuzzing, Repeats & Focus Isolation ---", flush=True)

    # 1.1 Rapid 10-tap space burst
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('highlighter')")

    burst_ok = True
    expected = "pen"
    for i in range(10):
        pg.keyboard.down("Space")
        pg.wait_for_timeout(20)
        pg.keyboard.up("Space")
        pg.wait_for_timeout(20)
        curr = pg.evaluate("window.state.activeTool")
        if curr != expected:
            burst_ok = False
            break
        expected = "highlighter" if expected == "pen" else "pen"
    check("rapid 10-tap space burst alternates predictably without state lock", burst_ok, f"final={curr}")

    # 1.2 Keyboard repeat events
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('eraser')")
    pg.evaluate("""() => {
        const evt1 = new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: false, bubbles: true });
        const evt2 = new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true, bubbles: true });
        const evt3 = new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true, bubbles: true });
        window.dispatchEvent(evt1);
        window.dispatchEvent(evt2);
        window.dispatchEvent(evt3);
    }""")
    tool_mid_repeat = pg.evaluate("window.state.activeTool")
    check("multiple keydown repeats maintain pan mode without resetting downTime incorrectly", tool_mid_repeat == "pan", f"tool={tool_mid_repeat}")
    
    pg.wait_for_timeout(30)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_repeat = pg.evaluate("window.state.activeTool")
    check("releasing after repeat correctly toggles to lastActiveTool (pen)", tool_after_repeat == "pen", f"tool={tool_after_repeat}")

    # 1.3 Focus inside text input does not trigger spacebar tool toggle
    pg.locator("#btnRailSearch").click(force=True)
    pg.wait_for_timeout(100)
    search_input = pg.locator("#drawerSearchInput")
    search_input.focus()
    pg.wait_for_timeout(50)
    pg.keyboard.press("Space")
    pg.wait_for_timeout(50)
    tool_during_input_space = pg.evaluate("window.state.activeTool")
    check("typing space inside search input does not toggle tools or engage pan", tool_during_input_space == "pen", f"tool={tool_during_input_space}")
    pg.locator("#btnCloseDrawer").click(force=True)
    pg.wait_for_timeout(100)

    # -------------------------------------------------------------
    # STRESS 2: PDF Text Selection Boundary & Adversarial Fuzzing
    # -------------------------------------------------------------
    print("\n--- [S2] PDF Text Selection Boundary & Stress Fuzzing ---", flush=True)

    pg.locator("#btnDockTextSelect").click(force=True)
    pg.wait_for_timeout(50)

    # Ensure page text data is loaded
    pg.evaluate("""async () => {
        const ts = await import('./js/workspace/text-selection.js');
        await ts.ensurePageTextData(0);
    }""")
    pg.wait_for_timeout(100)

    pts = pg.evaluate("""
    (() => {
      const vp = window.getViewport();
      const pl = vp.getPageLayout(0);
      const s_right = vp.worldToScreen(pl.x + 160, pl.y + 60, 'left');
      const s_left = vp.worldToScreen(pl.x + 55, pl.y + 60, 'left');
      const stageRect = document.getElementById('wet').getBoundingClientRect();
      return {
        rx: stageRect.left + s_right[0],
        ry: stageRect.top + s_right[1],
        lx: stageRect.left + s_left[0],
        ly: stageRect.top + s_left[1]
      };
    })()
    """)
    pg.mouse.move(pts["rx"], pts["ry"])
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(pts["lx"], pts["ly"])
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(100)

    rev_sel_text = pg.evaluate("window.state.selectedTextString || ''")
    check("negative drag (right-to-left) selects text accurately", "Hello" in rev_sel_text or "Ink" in rev_sel_text, f"text='{rev_sel_text}'")

    # 2.2 Word & Line Expansion via API
    word_sel = pg.evaluate("""
    (async () => {
      const ts = await import('./js/workspace/text-selection.js');
      const sel = ts.expandSelectionToWord(0, 7); // char 'n' in 'InkWell'
      return sel ? sel.text : null;
    })()
    """)
    check("expandSelectionToWord expands to word 'InkWell'", word_sel == "InkWell", f"word='{word_sel}'")

    line_sel = pg.evaluate("""
    (async () => {
      const ts = await import('./js/workspace/text-selection.js');
      const sel = ts.expandSelectionToLine(0, 7); // char 'n' in line 0
      return sel ? sel.text : null;
    })()
    """)
    check("expandSelectionToLine expands to full line 'Hello InkWell'", line_sel and "Hello InkWell" in line_sel, f"line='{line_sel}'")

    # 2.3 Explicit clearTextSelection resets selection state and popover
    pg.evaluate("import('./js/workspace/text-selection.js').then(ts => ts.clearTextSelection())")
    pg.wait_for_timeout(50)
    cleared = pg.evaluate("window.state.textSelection === null && window.state.selectedTextString === ''")
    check("clearTextSelection resets selection state and hides overlay", cleared)

    # -------------------------------------------------------------
    # STRESS 3: Touch Target Precision Hit-Testing at Strict Boundaries
    # -------------------------------------------------------------
    print("\n--- [S3] Touch Target Hit-Testing at Subpixel & 44px Boundaries ---", flush=True)

    header_buttons = [
        ('#btnNavBack', 'nav back button'),
        ('#btnNavForward', 'nav forward button'),
        ('#btnHeaderSave', 'header save button'),
        ('#btnHeaderPrevPage', 'header prev page button'),
        ('#btnHeaderNextPage', 'header next page button'),
    ]
    all_header_pass = True
    for sel, label in header_buttons:
        hit_ok = pg.evaluate(f"""(() => {{
            const btn = document.querySelector('{sel}');
            if (!btn) return false;
            const r = btn.getBoundingClientRect();
            // Test 3px above the visual top border (within the 44x44 pseudo target)
            const targetEl = document.elementFromPoint(r.left + r.width / 2, r.top - 3);
            return targetEl === btn || btn.contains(targetEl);
        }})()""")
        if not hit_ok:
            all_header_pass = False
            check(f"hit-test on {label} ({sel}) at top margin", False)
    if all_header_pass:
        check("header navigation and action controls trigger across expanded pseudo-element bounds", True)

    # -------------------------------------------------------------
    # STRESS 4: Zoom Clamping, Invariant Limits & Split View Isolation
    # -------------------------------------------------------------
    print("\n--- [S4] Zoom Clamping, Invariant Limits & Split View Isolation ---", flush=True)

    # 4.1 Extreme Zoom In
    for _ in range(25):
        pg.evaluate("window.getViewport().zoomIn()")
    max_zoom = pg.evaluate("window.getViewport().zoom")
    max_zoom_text = pg.locator("#zoomLevelDisplay").text_content()
    check("extreme zoom in is safely clamped <= 10.0x without NaN", 0 < max_zoom <= 10.0, f"zoom={max_zoom} text={max_zoom_text}")

    # 4.2 Extreme Zoom Out
    for _ in range(40):
        pg.evaluate("window.getViewport().zoomOut()")
    min_zoom = pg.evaluate("window.getViewport().zoom")
    min_zoom_text = pg.locator("#zoomLevelDisplay").text_content()
    check("extreme zoom out is safely clamped >= 0.15x without NaN or zero division", 0.15 <= min_zoom <= 0.20, f"zoom={min_zoom} text={min_zoom_text}")

    # Reset zoom to 100%
    pg.evaluate("window.getViewport().setZoom(1.0); if (window.emitZoomChanged) window.emitZoomChanged(window.getViewport());")
    pg.wait_for_timeout(50)

    # 4.3 Split Mode Pan/Zoom Independence
    pg.evaluate("window.getViewport().toggleSplitMode()")
    pg.wait_for_timeout(50)
    split_active = pg.evaluate("window.getViewport().splitMode")
    check("split mode engages cleanly", split_active)

    pg.evaluate("window.getViewport().setZoom(1.5, null, 'left')")
    pg.evaluate("window.getViewport().setZoom(0.8, null, 'right')")
    left_z = pg.evaluate("window.getViewport().zoom")
    right_z = pg.evaluate("window.getViewport().rightZoom")
    check("left and right pane zoom states operate completely independently", left_z == 1.5 and right_z == 0.8, f"left={left_z} right={right_z}")

    # Restore single pane
    pg.evaluate("window.getViewport().toggleSplitMode()")
    pg.wait_for_timeout(50)

    # -------------------------------------------------------------
    # STRESS 5: 100 Random Tool Transitions Stress Harness
    # -------------------------------------------------------------
    print("\n--- [S5] 100 Random Tool Transitions Stress Harness ---", flush=True)

    tools = ['pen', 'highlighter', 'eraser', 'lasso', 'rect', 'text', 'laser', 'pan', 'textSelect']
    random.seed(42)
    transitions_ok = True
    for step in range(100):
        next_tool = random.choice(tools)
        pg.evaluate(f"window.toolManager.setTool('{next_tool}')")
        active = pg.evaluate("window.state.activeTool")
        if active != next_tool:
            transitions_ok = False
            check(f"tool transition step {step} to {next_tool}", False, f"active={active}")
            break
        has_cls = pg.evaluate(f"document.getElementById('wet').classList.contains('tool-{next_tool}')")
        if not has_cls:
            transitions_ok = False
            check(f"canvas class tool-{next_tool} missing", False)
            break
    if transitions_ok:
        check("100 rapid random tool transitions execute with 100% state & DOM class synchronization", True)

    # -------------------------------------------------------------
    # STRESS 6: Undo/Redo & State Synchronization Invariants
    # -------------------------------------------------------------
    print("\n--- [S6] Undo/Redo & State Synchronization Invariants ---", flush=True)

    pg.evaluate("window.toolManager.setTool('pen')")
    cdp = ctx.new_cdp_session(pg)
    box = pg.locator("#wet").bounding_box()
    ox, oy = box["x"] + 200, box["y"] + 200

    cdp.send("Input.dispatchMouseEvent", {
        "type": "mousePressed", "x": ox, "y": oy, "button": "left",
        "buttons": 1, "pointerType": "pen", "force": 0.5, "clickCount": 1
    })
    for i in range(15):
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": ox + i * 10, "y": oy + i * 5,
            "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.6
        })
    cdp.send("Input.dispatchMouseEvent", {
        "type": "mouseReleased", "x": ox + 150, "y": oy + 75,
        "button": "left", "buttons": 0, "pointerType": "pen", "force": 0.1
    })
    pg.wait_for_timeout(200)

    initial_strokes = pg.evaluate("window.state.strokes.filter(s => !s.deleted).length")
    check("initial synthetic stroke committed", initial_strokes >= 1, f"activeStrokes={initial_strokes}")

    # Undo via Ctrl+Z
    pg.keyboard.press("Control+z")
    pg.wait_for_timeout(100)
    strokes_after_undo = pg.evaluate("window.state.strokes.filter(s => !s.deleted).length")
    check("Ctrl+Z (Undo) deletes active stroke", strokes_after_undo == initial_strokes - 1, f"activeStrokes={strokes_after_undo}")

    # Redo via Ctrl+Y
    pg.keyboard.press("Control+y")
    pg.wait_for_timeout(100)
    strokes_after_redo = pg.evaluate("window.state.strokes.filter(s => !s.deleted).length")
    check("Ctrl+Y (Redo) restores stroke cleanly", strokes_after_redo == initial_strokes, f"activeStrokes={strokes_after_redo}")

    # -------------------------------------------------------------
    # STRESS 7: Console Hygiene & Error Invariants
    # -------------------------------------------------------------
    print("\n--- [S7] Final Console Hygiene & Invariant Verification ---", flush=True)
    check("zero unhandled JavaScript exceptions across entire stress session", not errors, str(errors[:3]))
    inkwell_warns = [w for w in warnings if "[inkwell/" in w]
    check("zero internal [inkwell/ warnings during stress run", not inkwell_warns, str(inkwell_warns[:3]))

    b.close()

print(f"\n{'='*62}\n  {sum(results)}/{len(results)} adversarial stress checks passed\n{'='*62}", flush=True)
sys.exit(0 if all(results) else 1)
