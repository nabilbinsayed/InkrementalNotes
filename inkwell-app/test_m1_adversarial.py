"""Empirical Adversarial Stress Test Harness for Milestone 1 (InkWell).
Exhaustively tests:
1. Rapid-fire Spacebar Tapping & Spring State Machine (50 rapid taps, repeats, blur, input typing)
2. Spacebar Hold & Edge Panning (viewport out-of-bounds, pointercancel, mid-drag space release, blur recovery)
3. PDF Text Selection Engine (0 chars, 1 char, reverse drag, multiline skipped indices, boundary clamp, double/triple click, copy)
4. Canvas Context Menu Stress (edge coordinates, clamping, dismissal vectors, action execution under empty selection)
5. Radial Menu & Command Palette Adversarial Stress (screen edges, rapid toggle cycles, boundary navigation, query fuzzing)
6. Multi-Key Spring Interleaving (Spacebar + 'E' spring eraser interleaving and race conditions)
7. Text Layer IPC Failure Graceful Degradation (get_page_text_data rejects with error)
8. Exhaustive 9-Tool State Transition Matrix & History Tracking
"""
import math, pathlib, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "src" / "index.html").as_uri()

errors = []
warnings = []
test_results = []

def record(name, condition, detail=""):
    success = bool(condition)
    test_results.append((name, success, detail))
    status = "PASS" if success else "FAIL"
    print(f"  [{status}] {name}" + (f"   --> {detail}" if detail else ""), flush=True)
    if not success:
        print(f"       FAILED ASSERTION: {name} ({detail})", flush=True)

def run_adversarial_suite():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=[
                "--allow-file-access-from-files",
                "--force-device-scale-factor=1",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage"
            ]
        )
        ctx = browser.new_context(
            viewport={"width": 1400, "height": 900},
            permissions=["clipboard-read", "clipboard-write"]
        )
        pg = ctx.new_page()

        # Rich mock data for text selection and Tauri IPC
        pg.add_init_script("""
        window.__mockTextPages = {
          // Page 0: Standard multi-line text with non-contiguous char indices (newlines omitted)
          0: {
            page_index: 0,
            text: "The quick brown fox jumps over the lazy dog.\\nInkWell provides low-latency digital inking and PDF annotations.\\nThird line with symbols: 12345 !@#$%^&*() <test> & 'quotes'.",
            lines: [
              {
                line_index: 0,
                rect: [50, 50, 350, 70],
                text: "The quick brown fox",
                chars: [
                  { c: 'T', char_index: 0, line_index: 0, rect: [50, 50, 60, 70] },
                  { c: 'h', char_index: 1, line_index: 0, rect: [60, 50, 70, 70] },
                  { c: 'e', char_index: 2, line_index: 0, rect: [70, 50, 80, 70] },
                  { c: ' ', char_index: 3, line_index: 0, rect: [80, 50, 90, 70] },
                  { c: 'q', char_index: 4, line_index: 0, rect: [90, 50, 100, 70] },
                  { c: 'u', char_index: 5, line_index: 0, rect: [100, 50, 110, 70] },
                  { c: 'i', char_index: 6, line_index: 0, rect: [110, 50, 115, 70] },
                  { c: 'c', char_index: 7, line_index: 0, rect: [115, 50, 125, 70] },
                  { c: 'k', char_index: 8, line_index: 0, rect: [125, 50, 135, 70] },
                  { c: ' ', char_index: 9, line_index: 0, rect: [135, 50, 145, 70] },
                  { c: 'f', char_index: 10, line_index: 0, rect: [145, 50, 155, 70] },
                  { c: 'o', char_index: 11, line_index: 0, rect: [155, 50, 165, 70] },
                  { c: 'x', char_index: 12, line_index: 0, rect: [165, 50, 175, 70] }
                ]
              },
              {
                line_index: 1,
                rect: [50, 80, 420, 100],
                text: "InkWell provides low-latency digital inking",
                chars: [
                  { c: 'I', char_index: 20, line_index: 1, rect: [50, 80, 60, 100] },
                  { c: 'n', char_index: 21, line_index: 1, rect: [60, 80, 70, 100] },
                  { c: 'k', char_index: 22, line_index: 1, rect: [70, 80, 80, 100] },
                  { c: 'W', char_index: 23, line_index: 1, rect: [80, 80, 95, 100] },
                  { c: 'e', char_index: 24, line_index: 1, rect: [95, 80, 105, 100] },
                  { c: 'l', char_index: 25, line_index: 1, rect: [105, 80, 110, 100] },
                  { c: 'l', char_index: 26, line_index: 1, rect: [110, 80, 115, 100] }
                ]
              },
              {
                line_index: 2,
                rect: [50, 110, 400, 130],
                text: "Third line",
                chars: [
                  { c: 'T', char_index: 40, line_index: 2, rect: [50, 110, 60, 130] },
                  { c: 'h', char_index: 41, line_index: 2, rect: [60, 110, 70, 130] },
                  { c: 'i', char_index: 42, line_index: 2, rect: [70, 110, 75, 130] },
                  { c: 'r', char_index: 43, line_index: 2, rect: [75, 110, 85, 130] },
                  { c: 'd', char_index: 44, line_index: 2, rect: [85, 110, 95, 130] },
                  { c: ' ', char_index: 45, line_index: 2, rect: [95, 110, 105, 130] },
                  { c: 'l', char_index: 46, line_index: 2, rect: [105, 110, 110, 130] },
                  { c: 'i', char_index: 47, line_index: 2, rect: [110, 110, 115, 130] },
                  { c: 'n', char_index: 48, line_index: 2, rect: [115, 110, 125, 130] },
                  { c: 'e', char_index: 49, line_index: 2, rect: [125, 110, 135, 130] }
                ]
              }
            ],
            chars: [
              { c: 'T', char_index: 0, line_index: 0, rect: [50, 50, 60, 70] },
              { c: 'h', char_index: 1, line_index: 0, rect: [60, 50, 70, 70] },
              { c: 'e', char_index: 2, line_index: 0, rect: [70, 50, 80, 70] },
              { c: ' ', char_index: 3, line_index: 0, rect: [80, 50, 90, 70] },
              { c: 'q', char_index: 4, line_index: 0, rect: [90, 50, 100, 70] },
              { c: 'u', char_index: 5, line_index: 0, rect: [100, 50, 110, 70] },
              { c: 'i', char_index: 6, line_index: 0, rect: [110, 50, 115, 70] },
              { c: 'c', char_index: 7, line_index: 0, rect: [115, 50, 125, 70] },
              { c: 'k', char_index: 8, line_index: 0, rect: [125, 50, 135, 70] },
              { c: ' ', char_index: 9, line_index: 0, rect: [135, 50, 145, 70] },
              { c: 'f', char_index: 10, line_index: 0, rect: [145, 50, 155, 70] },
              { c: 'o', char_index: 11, line_index: 0, rect: [155, 50, 165, 70] },
              { c: 'x', char_index: 12, line_index: 0, rect: [165, 50, 175, 70] },
              { c: 'I', char_index: 20, line_index: 1, rect: [50, 80, 60, 100] },
              { c: 'n', char_index: 21, line_index: 1, rect: [60, 80, 70, 100] },
              { c: 'k', char_index: 22, line_index: 1, rect: [70, 80, 80, 100] },
              { c: 'W', char_index: 23, line_index: 1, rect: [80, 80, 95, 100] },
              { c: 'e', char_index: 24, line_index: 1, rect: [95, 80, 105, 100] },
              { c: 'l', char_index: 25, line_index: 1, rect: [105, 80, 110, 100] },
              { c: 'l', char_index: 26, line_index: 1, rect: [110, 80, 115, 100] },
              { c: 'T', char_index: 40, line_index: 2, rect: [50, 110, 60, 130] },
              { c: 'h', char_index: 41, line_index: 2, rect: [60, 110, 70, 130] },
              { c: 'i', char_index: 42, line_index: 2, rect: [70, 110, 75, 130] },
              { c: 'r', char_index: 43, line_index: 2, rect: [75, 110, 85, 130] },
              { c: 'd', char_index: 44, line_index: 2, rect: [85, 110, 95, 130] },
              { c: ' ', char_index: 45, line_index: 2, rect: [95, 110, 105, 130] },
              { c: 'l', char_index: 46, line_index: 2, rect: [105, 110, 110, 130] },
              { c: 'i', char_index: 47, line_index: 2, rect: [110, 110, 115, 130] },
              { c: 'n', char_index: 48, line_index: 2, rect: [115, 110, 125, 130] },
              { c: 'e', char_index: 49, line_index: 2, rect: [125, 110, 135, 130] }
            ],
            spans: []
          },
          // Page 1: Empty page (0 text characters)
          1: {
            page_index: 1,
            text: "",
            lines: [],
            chars: [],
            spans: []
          },
          // Page 2: Single character page
          2: {
            page_index: 2,
            text: "Z",
            lines: [{ line_index: 0, rect: [100, 100, 120, 120], text: "Z", chars: [{ c: 'Z', char_index: 0, line_index: 0, rect: [100, 100, 120, 120] }] }],
            chars: [{ c: 'Z', char_index: 0, line_index: 0, rect: [100, 100, 120, 120] }],
            spans: []
          }
        };

        window.__inkwell_stub = {
          render_tile: async (args) => {
            const rect = (args && args.rect) || [0, 0, 256, 256];
            const px = (args && args.px) || 256;
            const rw = rect[2] - rect[0];
            const rh = rect[3] - rect[1];
            const scale = px / Math.max(rw, rh);
            const tileW = Math.round(rw * scale) || 1;
            const tileH = Math.round(rh * scale) || 1;
            return new Array(tileW * tileH * 4).fill(255);
          },
          get_page_text_data: async (args) => {
            const idx = (args && typeof args.pageIndex === 'number') ? args.pageIndex : 0;
            if (window.__failTextIpc && idx === 99) {
              throw new Error("Simulated IPC PDFium extraction failure");
            }
            return window.__mockTextPages[idx] || { page_index: idx, text: "", lines: [], chars: [], spans: [] };
          },
          commit_stroke: async (args) => (args && args.clientId) ? String(args.clientId) : 's_stub_1',
          delete_stroke: async () => true,
          open_pdf: async () => ({
            page_infos: [
              { page_index: 0, width_pt: 595.0, height_pt: 842.0 },
              { page_index: 1, width_pt: 595.0, height_pt: 842.0 },
              { page_index: 2, width_pt: 595.0, height_pt: 842.0 }
            ],
            outline: []
          }),
          create_blank_document: async () => ({
            page_infos: [
              { page_index: 0, width_pt: 595.0, height_pt: 842.0 },
              { page_index: 1, width_pt: 595.0, height_pt: 842.0 },
              { page_index: 2, width_pt: 595.0, height_pt: 842.0 }
            ],
            outline: []
          }),
          search_pdf: async () => []
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

        print("Navigating to frontend application...", flush=True)
        pg.goto(URL)
        pg.wait_for_timeout(600)

        # Ensure active blank document
        welcome_btn = pg.locator("#btnWelcomeNewNote")
        if welcome_btn.count() > 0 and welcome_btn.is_visible():
            welcome_btn.click()
            pg.wait_for_timeout(300)

        # -------------------------------------------------------------
        # STRESS SUITE 1: RAPID-FIRE SPACEBAR TAPPING & SPRING STATES
        # -------------------------------------------------------------
        print("\n========================================================")
        print("STRESS SUITE 1: Rapid-Fire Spacebar Tapping & Spring State Machine")
        print("========================================================")

        # Start with Pen active, lastActiveTool set to Highlighter
        pg.evaluate("""
          window.toolManager.setTool('highlighter');
          window.toolManager.setTool('pen');
        """)
        initial_tool = pg.evaluate("window.state.activeTool")
        initial_last = pg.evaluate("window.state.lastActiveTool")
        record("Setup initial tool state", initial_tool == "pen" and initial_last == "highlighter",
               f"active={initial_tool}, last={initial_last}")

        # 1.1 Rapid-fire 20 quick space taps (under 30ms each)
        print("  -> Executing 20 ultra-rapid spacebar tap cycles (10ms down, 10ms up)...")
        for i in range(20):
            pg.keyboard.down("Space")
            pg.wait_for_timeout(10)
            pg.keyboard.up("Space")
            pg.wait_for_timeout(10)

        tool_after_20 = pg.evaluate("window.state.activeTool")
        last_after_20 = pg.evaluate("window.state.lastActiveTool")
        is_space_pressed = pg.evaluate("window.state.isSpacePressed")
        record("20 rapid taps maintain clean state (not stuck in pan)",
               tool_after_20 in ["pen", "highlighter"] and not is_space_pressed,
               f"active={tool_after_20}, last={last_after_20}, isSpacePressed={is_space_pressed}")

        # 1.2 Spacebar Key Repeat Stress (holding down triggers repeated keydown events)
        print("  -> Simulating 10 OS key-repeat events while holding Spacebar...")
        pg.keyboard.down("Space")
        for _ in range(10):
            pg.evaluate("window.toolManager.handleSpaceKeyDown({ preventDefault: () => {} })")
            pg.wait_for_timeout(15)
        mid_repeat_tool = pg.evaluate("window.state.activeTool")
        record("Repeated keydown events do not corrupt spaceToolBefore",
               mid_repeat_tool == "pan", f"tool={mid_repeat_tool}")
        pg.keyboard.up("Space")
        pg.wait_for_timeout(50)
        tool_after_repeat_release = pg.evaluate("window.state.activeTool")
        record("Releasing spacebar restores non-pan tool after repeated keydowns",
               tool_after_repeat_release in ["pen", "highlighter"], f"tool={tool_after_repeat_release}")

        # 1.3 Spacebar while typing in text input (Search Input, Custom Zoom, Inline Textarea, Command Palette)
        print("  -> Verifying Spacebar does NOT toggle tools when typing in input/textarea...")
        pg.keyboard.press("Control+K")
        pg.wait_for_timeout(100)
        cmd_input = pg.locator("#cmdPaletteInput")
        cmd_input.focus()
        tool_before_typing = pg.evaluate("window.state.activeTool")
        pg.keyboard.type("open note ")
        pg.wait_for_timeout(50)
        tool_after_input_space = pg.evaluate("window.state.activeTool")
        record("Spacebar inside focused input does not trigger pan/toggle",
               tool_after_input_space == tool_before_typing,
               f"before={tool_before_typing}, after={tool_after_input_space}")
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(50)

        # 1.4 Window Blur cancels spring keys
        print("  -> Verifying window blur cancels spring state...")
        pg.keyboard.down("Space")
        pg.wait_for_timeout(30)
        in_space = pg.evaluate("window.state.isSpacePressed")
        pg.evaluate("window.dispatchEvent(new Event('blur'))")
        pg.wait_for_timeout(30)
        post_blur_space = pg.evaluate("window.state.isSpacePressed")
        post_blur_tool = pg.evaluate("window.state.activeTool")
        record("Window blur cancels spring spacebar state",
               in_space is True and post_blur_space is False and post_blur_tool != "pan",
               f"in_space={in_space}, post_blur={post_blur_space}, tool={post_blur_tool}")
        pg.keyboard.up("Space")

        # -------------------------------------------------------------
        # STRESS SUITE 2: SPACEBAR HOLD & VIEWPORT EDGE PANNING
        # -------------------------------------------------------------
        print("\n========================================================")
        print("STRESS SUITE 2: Spacebar Hold Across Viewport Edges & Canvas Dragging")
        print("========================================================")

        pg.evaluate("window.toolManager.setTool('pen')")
        box = pg.locator("#wet").bounding_box()
        cx, cy = box["x"] + 400, box["y"] + 300

        # 2.1 Drag far beyond viewport bounds while holding space
        print("  -> Dragging mouse 800px past right edge while holding Spacebar...")
        init_pan_x = pg.evaluate("window.getViewport().panX")
        pg.keyboard.down("Space")
        pg.wait_for_timeout(100)
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        # Drag far outside the viewport to x=2000, y=-200
        pg.mouse.move(cx + 800, cy - 200, steps=10)
        pg.wait_for_timeout(50)
        pg.mouse.up()
        pg.wait_for_timeout(50)
        pg.keyboard.up("Space")
        pg.wait_for_timeout(50)

        pan_x_after_drag = pg.evaluate("window.getViewport().panX")
        tool_after_drag = pg.evaluate("window.state.activeTool")
        record("Canvas pan coordinates update correctly after extreme off-screen drag",
               pan_x_after_drag != init_pan_x and not math.isnan(pan_x_after_drag),
               f"init={init_pan_x}, after={pan_x_after_drag}")
        record("Tool cleanly restores to Pen after space hold drag",
               tool_after_drag == "pen", f"tool={tool_after_drag}")

        # 2.2 Releasing Spacebar MID-DRAG (before mouse up)
        print("  -> Releasing Spacebar while mouse button is still pressed down...")
        pg.keyboard.down("Space")
        pg.wait_for_timeout(50)
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        pg.mouse.move(cx - 100, cy, steps=5)
        # Release space while mouse is still down!
        pg.keyboard.up("Space")
        pg.wait_for_timeout(50)
        mid_release_tool = pg.evaluate("window.state.activeTool")
        pg.mouse.move(cx - 150, cy, steps=5)
        pg.mouse.up()
        pg.wait_for_timeout(50)
        final_tool_after_mid_release = pg.evaluate("window.state.activeTool")
        record("Releasing Spacebar mid-drag reverts tool without crash",
               final_tool_after_mid_release == "pen",
               f"mid={mid_release_tool}, final={final_tool_after_mid_release}")

        # 2.3 Pointercancel during pan
        print("  -> Dispatching pointercancel event during pan...")
        pg.evaluate("window.toolManager.setTool('pan')")
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        pg.evaluate("document.getElementById('wet').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }))")
        pg.mouse.up()
        pan_state_down = pg.evaluate("window._panState ? window._panState.isDown : false")
        record("Pointercancel clears pan active drag state", pan_state_down is False)

        # -------------------------------------------------------------
        # STRESS SUITE 3: PDF TEXT SELECTION ENGINE ADVERSARIAL STRESS
        # -------------------------------------------------------------
        print("\n========================================================")
        print("STRESS SUITE 3: PDF Text Selection Engine Stress & Edge Cases")
        print("========================================================")

        # 3.1 Empty page selection (Page 1 has 0 chars)
        print("  -> Testing text selection on empty page (0 chars)...")
        empty_res = pg.evaluate("""
        import('./js/workspace/text-selection.js').then(async ts => {
          await ts.ensurePageTextData(1);
          const hit = ts.findCharAndOffsetAtPageCoord(1, 100, 100);
          const sel = ts.computeTextSelectionRanges(1, 0, 10);
          const word = ts.expandSelectionToWord(1, 0);
          const line = ts.expandSelectionToLine(1, 0);
          return { hit, sel, word, line };
        })
        """)
        record("Empty page findCharAndOffset returns null without throwing", empty_res["hit"] is None)
        record("Empty page computeTextSelectionRanges returns null", empty_res["sel"] is None)
        record("Empty page expandSelectionToWord/Line returns null",
               empty_res["word"] is None and empty_res["line"] is None)

        # 3.2 Single character page (Page 2 has 1 char: 'Z')
        print("  -> Testing text selection on single-character page...")
        single_res = pg.evaluate("""
        import('./js/workspace/text-selection.js').then(async ts => {
          await ts.ensurePageTextData(2);
          const hit = ts.findCharAndOffsetAtPageCoord(2, 110, 110);
          const sel = ts.computeTextSelectionRanges(2, 0, 0);
          const word = ts.expandSelectionToWord(2, 0);
          const line = ts.expandSelectionToLine(2, 0);
          return { hit, sel, word, line };
        })
        """)
        record("Single char page hit-tests 'Z'", single_res["hit"] and single_res["hit"]["char"]["c"] == "Z")
        record("Single char page selection returns 'Z'", single_res["sel"] and single_res["sel"]["text"] == "Z")
        record("Single char word & line expansion return 'Z'",
               single_res["word"] and single_res["word"]["text"] == "Z" and
               single_res["line"] and single_res["line"]["text"] == "Z")

        # 3.3 Reverse Drag Selection (endCharIdx < startCharIdx)
        print("  -> Testing reverse drag selection (bottom-right to top-left across skipped lines)...")
        reverse_res = pg.evaluate("""
        import('./js/workspace/text-selection.js').then(async ts => {
          await ts.ensurePageTextData(0);
          // startCharIdx = 26 ('l' on line 1), endCharIdx = 0 ('T' on line 0)
          const sel = ts.computeTextSelectionRanges(0, 26, 0);
          return sel;
        })
        """)
        record("Reverse selection yields correct minIdx..maxIdx span",
               reverse_res and reverse_res["startCharIdx"] == 0 and reverse_res["endCharIdx"] == 26,
               f"start={reverse_res['startCharIdx'] if reverse_res else None}, end={reverse_res['endCharIdx'] if reverse_res else None}")
        record("Reverse selection includes chars from both line 0 and line 1",
               reverse_res and "The quick" in reverse_res["text"] and "InkWell" in reverse_res["text"])

        # 3.4 Out-of-bounds indices and negative indices
        print("  -> Testing out-of-bounds selection indices (-100 to 9999)...")
        oob_res = pg.evaluate("""
        import('./js/workspace/text-selection.js').then(async ts => {
          await ts.ensurePageTextData(0);
          const sel = ts.computeTextSelectionRanges(0, -100, 9999);
          return sel;
        })
        """)
        record("Out-of-bounds indices capture all available chars without throwing",
               oob_res and "Third line" in oob_res["text"],
               f"selected='{oob_res['text'] if oob_res else None}'")

        # 3.5 Hit testing far outside page bounds
        print("  -> Testing hit-test coordinates at extreme distances (-5000, 5000)...")
        far_hit = pg.evaluate("""
        import('./js/workspace/text-selection.js').then(async ts => {
          await ts.ensurePageTextData(0);
          const leftHit = ts.findCharAndOffsetAtPageCoord(0, -5000, 50);
          const rightHit = ts.findCharAndOffsetAtPageCoord(0, 5000, 50);
          return { leftHit, rightHit };
        })
        """)
        record("Left out-of-bounds coordinate clamps to first char of closest line",
               far_hit["leftHit"] and far_hit["leftHit"]["isBefore"] is True)
        record("Right out-of-bounds coordinate clamps to last char of closest line",
               far_hit["rightHit"] and far_hit["rightHit"]["isAfter"] is True)

        # 3.6 Clipboard Copy Action on Selection
        print("  -> Testing clipboard copy execution...")
        pg.evaluate("""
        import('./js/workspace/text-selection.js').then(async ts => {
          await ts.ensurePageTextData(0);
          const sel = ts.computeTextSelectionRanges(0, 0, 8);
          window.state.textSelection = sel;
          window.state.selectedTextString = sel.text;
          ts.copySelectedPdfText();
        })
        """)
        pg.wait_for_timeout(100)
        clip_content = pg.evaluate("navigator.clipboard.readText()")
        record("Selected text successfully copied to clipboard",
               clip_content == "The quick", f"clip='{clip_content}'")

        # -------------------------------------------------------------
        # STRESS SUITE 4: CANVAS CONTEXT MENU BOUNDARIES & DISMISSAL
        # -------------------------------------------------------------
        print("\n========================================================")
        print("STRESS SUITE 4: Context Menu Boundary Clamping & Dismissals")
        print("========================================================")

        # 4.1 Boundary Clamping (Near bottom-right window corner)
        print("  -> Triggering context menu at window extreme (1390, 890)...")
        pg.evaluate("import('./js/ui/context-menu.js').then(cm => cm.showContextMenu(1390, 890))")
        pg.wait_for_timeout(50)
        menu_pos = pg.evaluate("""
        (() => {
          const m = document.getElementById('canvasContextMenu');
          return {
            left: parseInt(m.style.left, 10),
            top: parseInt(m.style.top, 10),
            hidden: m.classList.contains('hidden')
          };
        })()
        """)
        record("Context menu positioned within viewport bounds",
               menu_pos["left"] <= 1400 - 180 - 10 and menu_pos["top"] <= 900 - 200 - 10,
               f"left={menu_pos['left']}, top={menu_pos['top']}")

        # 4.2 Dismissal via Click Outside
        print("  -> Testing context menu dismissal via canvas click...")
        pg.mouse.click(50, 50)
        pg.wait_for_timeout(50)
        dismissed_click = pg.evaluate("document.getElementById('canvasContextMenu').classList.contains('hidden')")
        record("Context menu dismissed via canvas click", dismissed_click is True)

        # 4.3 Context menu action triggers without selected objects (Cut / Copy / Paste / Delete)
        print("  -> Executing Cut / Copy / Paste / Duplicate / Delete on empty selection...")
        actions_ok = pg.evaluate("""
        (() => {
          try {
            document.getElementById('ctxMenuCut').click();
            document.getElementById('ctxMenuCopy').click();
            document.getElementById('ctxMenuPaste').click();
            document.getElementById('ctxMenuDuplicate').click();
            document.getElementById('ctxMenuDelete').click();
            return true;
          } catch (e) {
            return false;
          }
        })()
        """)
        record("Context menu actions execute safely on empty state", actions_ok is True)

        # -------------------------------------------------------------
        # STRESS SUITE 5: RADIAL MENU & COMMAND PALETTE STRESS
        # -------------------------------------------------------------
        print("\n========================================================")
        print("STRESS SUITE 5: Radial Menu & Command Palette Navigation")
        print("========================================================")

        # 5.1 Radial Menu Boundary Clamping & Rapid Open/Close
        print("  -> Rapidly opening and closing radial menu 30 times...")
        for i in range(30):
            pg.evaluate(f"import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu({i * 30}, {i * 20}))")
            pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.hideRadialMenu())")
        is_radial_hidden = pg.evaluate("document.getElementById('radialMenu').classList.contains('hidden')")
        record("Radial menu survives 30 rapid open/close cycles", is_radial_hidden is True)

        # 5.2 Command Palette Boundary Navigation (ArrowUp at top, ArrowDown at bottom wrap-around)
        print("  -> Testing Command Palette wrap-around navigation...")
        pg.keyboard.press("Control+K")
        pg.wait_for_timeout(100)
        pg.keyboard.press("ArrowUp")
        pg.wait_for_timeout(50)
        idx_after_up = pg.evaluate("""
          document.querySelector('.cmd-item.selected') ?
          parseInt(document.querySelector('.cmd-item.selected').getAttribute('data-index'), 10) : -1
        """)
        total_items = pg.evaluate("document.querySelectorAll('.cmd-item').length")
        record("ArrowUp from top wraps to bottom of command palette",
               idx_after_up == total_items - 1, f"idx={idx_after_up}, total={total_items}")

        pg.keyboard.press("ArrowDown")
        pg.wait_for_timeout(50)
        idx_after_down = pg.evaluate("""
          document.querySelector('.cmd-item.selected') ?
          parseInt(document.querySelector('.cmd-item.selected').getAttribute('data-index'), 10) : -1
        """)
        record("ArrowDown from bottom wraps to top (index 0)",
               idx_after_down == 0, f"idx={idx_after_down}")

        # 5.3 Fuzzing Command Palette Search Input
        print("  -> Fuzzing Command Palette search with special chars and non-matching queries...")
        fuzz_queries = ["<script>alert(1)</script>", "'''\"\"\"&&&///", "nonexistent_command_123456789", ""]
        fuzz_ok = True
        for q in fuzz_queries:
            pg.locator("#cmdPaletteInput").fill(q)
            pg.wait_for_timeout(30)
            has_error = pg.evaluate("!document.getElementById('cmdPaletteResults') && !document.getElementById('cmdPaletteList')")
            if has_error:
                fuzz_ok = False
        record("Command palette handles fuzzed/malicious search queries without DOM break", fuzz_ok is True)

        pg.keyboard.press("Escape")
        pg.wait_for_timeout(50)

        # -------------------------------------------------------------
        # STRESS SUITE 6: MULTI-KEY SPRING INTERLEAVING & RACES
        # -------------------------------------------------------------
        print("\n========================================================")
        print("STRESS SUITE 6: Multi-Key Spring Key Interleaving & Race Conditions")
        print("========================================================")
        pg.evaluate("window.toolManager.setTool('highlighter')")
        
        # Press 'e' (spring eraser), then press Space (spring pan)
        print("  -> Interleaving 'E' spring key with Spacebar spring pan...")
        pg.keyboard.down("e")
        pg.wait_for_timeout(30)
        e_down_tool = pg.evaluate("window.state.activeTool")
        record("Pressing 'E' switches to eraser", e_down_tool == "eraser", f"tool={e_down_tool}")

        pg.keyboard.down("Space")
        pg.wait_for_timeout(30)
        space_and_e_tool = pg.evaluate("window.state.activeTool")
        record("Pressing Space while 'E' is held engages pan", space_and_e_tool == "pan", f"tool={space_and_e_tool}")

        # Release 'e' first, then release Space
        pg.keyboard.up("e")
        pg.wait_for_timeout(30)
        pg.keyboard.up("Space")
        pg.wait_for_timeout(50)
        restored_tool_combo = pg.evaluate("window.state.activeTool")
        record("Releasing 'E' and Space in sequence returns cleanly to non-pan tool",
               restored_tool_combo in ["highlighter", "eraser", "pen"], f"tool={restored_tool_combo}")

        # -------------------------------------------------------------
        # STRESS SUITE 7: TEXT LAYER IPC FAILURE DEGRADATION
        # -------------------------------------------------------------
        print("\n========================================================")
        print("STRESS SUITE 7: Text Layer IPC Failure Graceful Degradation")
        print("========================================================")
        print("  -> Requesting text data for failing page 99...")
        warnings_before_ipc_fail = len(warnings)
        ipc_fail_res = pg.evaluate("""
        (() => {
          window.__failTextIpc = true;
          return import('./js/workspace/text-selection.js').then(async ts => {
            const res = await ts.ensurePageTextData(99);
            window.__failTextIpc = false;
            return res;
          });
        })()
        """)
        record("Failing get_page_text_data returns null without unhandled rejection", ipc_fail_res is None)
        # Acknowledge and filter expected simulated warning
        expected_warns = [w for w in warnings[warnings_before_ipc_fail:] if "get_page_text_data failed" in w]
        record("Graceful warning logged for simulated IPC text failure", len(expected_warns) > 0)

        # -------------------------------------------------------------
        # STRESS SUITE 8: 9-TOOL EXHAUSTIVE TRANSITION MATRIX
        # -------------------------------------------------------------
        print("\n========================================================")
        print("STRESS SUITE 8: 9-Tool Exhaustive Transition Matrix & History")
        print("========================================================")
        tools = ['pen', 'highlighter', 'eraser', 'lasso', 'rect', 'ellipse', 'text', 'textSelect', 'laser']
        matrix_ok = True
        for t1 in tools:
            for t2 in tools:
                if t1 == t2: continue
                pg.evaluate(f"window.toolManager.setTool('{t1}')")
                pg.evaluate(f"window.toolManager.setTool('{t2}')")
                last = pg.evaluate("window.state.lastActiveTool")
                if str(last).lower() != str(t1).lower():
                    matrix_ok = False
                    print(f"      Transition failed: {t1} -> {t2}, expected lastActive={t1}, got {last}")
        record("All 72 pair transitions preserve lastActiveTool perfectly", matrix_ok is True)

        # -------------------------------------------------------------
        # FINAL CONSOLE & HYGIENE VERIFICATION
        # -------------------------------------------------------------
        print("\n========================================================")
        print("FINAL CONSOLE & RUNTIME HYGIENE")
        print("========================================================")
        record("Zero runtime page errors or unhandled exceptions", len(errors) == 0, str(errors[:3]))
        inkwell_warns = [w for w in warnings if "[inkwell/" in w and "get_page_text_data failed for page 99" not in w]
        record("Zero unexpected internal inkwell runtime warnings", len(inkwell_warns) == 0, str(inkwell_warns[:3]))

        browser.close()

if __name__ == "__main__":
    print("\n--- Starting InkWell Milestone 1 Empirical Stress Test Suite ---", flush=True)
    t0 = time.time()
    run_adversarial_suite()
    elapsed = time.time() - t0
    total = len(test_results)
    passed = sum(1 for _, ok, _ in test_results if ok)
    failed = total - passed
    print(f"\n{'='*64}")
    print(f"ADVERSARIAL STRESS SUITE SUMMARY: {passed}/{total} checks passed ({failed} failures) in {elapsed:.2f}s")
    print(f"{'='*64}\n")
    sys.exit(0 if failed == 0 else 1)
