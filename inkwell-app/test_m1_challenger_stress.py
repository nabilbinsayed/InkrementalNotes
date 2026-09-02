"""Comprehensive Adversarial Stress Test Suite for Milestone 1.
Challenger m1_2: Stress-tests tool state machine, clipboard copying,
radial menu interactions, and command palette boundary conditions.
"""
import math, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "src" / "index.html").as_uri()
errors, warnings = [], []
results = []
findings = []

def check(name, cond, note=""):
    results.append(bool(cond))
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {name}" + (f"   ({note})" if note else ""), flush=True)
    if not cond:
        findings.append(f"{name}: {note}")

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
      get_page_text_data: async () => ({
        page_index: 0,
        text: 'InkWell Adversarial Testing\\nRobustness and Reliability Evaluation',
        lines: [
          {
            line_index: 0,
            rect: [50, 50, 300, 70],
            text: 'InkWell Adversarial Testing',
            chars: [
              { c: 'I', char_index: 0, line_index: 0, rect: [50, 50, 60, 70] },
              { c: 'n', char_index: 1, line_index: 0, rect: [60, 50, 70, 70] },
              { c: 'k', char_index: 2, line_index: 0, rect: [70, 50, 80, 70] },
              { c: 'W', char_index: 3, line_index: 0, rect: [80, 50, 95, 70] },
              { c: 'e', char_index: 4, line_index: 0, rect: [95, 50, 105, 70] },
              { c: 'l', char_index: 5, line_index: 0, rect: [105, 50, 110, 70] },
              { c: 'l', char_index: 6, line_index: 0, rect: [110, 50, 115, 70] },
              { c: ' ', char_index: 7, line_index: 0, rect: [115, 50, 120, 70] },
              { c: 'A', char_index: 8, line_index: 0, rect: [120, 50, 130, 70] },
              { c: 'd', char_index: 9, line_index: 0, rect: [130, 50, 140, 70] },
              { c: 'v', char_index: 10, line_index: 0, rect: [140, 50, 150, 70] },
              { c: 'e', char_index: 11, line_index: 0, rect: [150, 50, 160, 70] },
              { c: 'r', char_index: 12, line_index: 0, rect: [160, 50, 170, 70] },
              { c: 's', char_index: 13, line_index: 0, rect: [170, 50, 180, 70] },
              { c: 'a', char_index: 14, line_index: 0, rect: [180, 50, 190, 70] },
              { c: 'r', char_index: 15, line_index: 0, rect: [190, 50, 200, 70] },
              { c: 'i', char_index: 16, line_index: 0, rect: [200, 50, 205, 70] },
              { c: 'a', char_index: 17, line_index: 0, rect: [205, 50, 215, 70] },
              { c: 'l', char_index: 18, line_index: 0, rect: [215, 50, 220, 70] }
            ]
          },
          {
            line_index: 1,
            rect: [50, 80, 320, 100],
            text: 'Robustness and Reliability Evaluation',
            chars: [
              { c: 'R', char_index: 20, line_index: 1, rect: [50, 80, 62, 100] },
              { c: 'o', char_index: 21, line_index: 1, rect: [62, 80, 74, 100] },
              { c: 'b', char_index: 22, line_index: 1, rect: [74, 80, 86, 100] },
              { c: 'u', char_index: 23, line_index: 1, rect: [86, 80, 98, 100] },
              { c: 's', char_index: 24, line_index: 1, rect: [98, 80, 110, 100] },
              { c: 't', char_index: 25, line_index: 1, rect: [110, 80, 122, 100] }
            ]
          }
        ],
        chars: [
          { c: 'I', char_index: 0, line_index: 0, rect: [50, 50, 60, 70] },
          { c: 'n', char_index: 1, line_index: 0, rect: [60, 50, 70, 70] },
          { c: 'k', char_index: 2, line_index: 0, rect: [70, 50, 80, 70] },
          { c: 'W', char_index: 3, line_index: 0, rect: [80, 50, 95, 70] },
          { c: 'e', char_index: 4, line_index: 0, rect: [95, 50, 105, 70] },
          { c: 'l', char_index: 5, line_index: 0, rect: [105, 50, 110, 70] },
          { c: 'l', char_index: 6, line_index: 0, rect: [110, 50, 115, 70] },
          { c: ' ', char_index: 7, line_index: 0, rect: [115, 50, 120, 70] },
          { c: 'A', char_index: 8, line_index: 0, rect: [120, 50, 130, 70] },
          { c: 'd', char_index: 9, line_index: 0, rect: [130, 50, 140, 70] },
          { c: 'v', char_index: 10, line_index: 0, rect: [140, 50, 150, 70] },
          { c: 'e', char_index: 11, line_index: 0, rect: [150, 50, 160, 70] },
          { c: 'r', char_index: 12, line_index: 0, rect: [160, 50, 170, 70] },
          { c: 's', char_index: 13, line_index: 0, rect: [170, 50, 180, 70] },
          { c: 'a', char_index: 14, line_index: 0, rect: [180, 50, 190, 70] },
          { c: 'r', char_index: 15, line_index: 0, rect: [190, 50, 200, 70] },
          { c: 'i', char_index: 16, line_index: 0, rect: [200, 50, 205, 70] },
          { c: 'a', char_index: 17, line_index: 0, rect: [205, 50, 215, 70] },
          { c: 'l', char_index: 18, line_index: 0, rect: [215, 50, 220, 70] },
          { c: 'R', char_index: 20, line_index: 1, rect: [50, 80, 62, 100] },
          { c: 'o', char_index: 21, line_index: 1, rect: [62, 80, 74, 100] },
          { c: 'b', char_index: 22, line_index: 1, rect: [74, 80, 86, 100] },
          { c: 'u', char_index: 23, line_index: 1, rect: [86, 80, 98, 100] },
          { c: 's', char_index: 24, line_index: 1, rect: [98, 80, 110, 100] },
          { c: 't', char_index: 25, line_index: 1, rect: [110, 80, 122, 100] }
        ],
        spans: []
      }),
      commit_stroke: async () => 's1',
      delete_stroke: async () => true,
      open_pdf: async () => ({ page_infos: [{ page_index: 0, width_pt: 595.0, height_pt: 842.0 }], outline: [] }),
      create_blank_document: async () => ({ page_infos: [{ page_index: 0, width_pt: 595.0, height_pt: 842.0 }], outline: [] }),
      search_pdf: async () => [],
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => window.__inkwell_stub[cmd](args)
    };
    window.__TAURI__ = {
      core: { invoke: window.__TAURI_INTERNALS__.invoke }
    };
    """)

    pg.on("console", lambda m: (errors if m.type == "error" else
                                warnings if m.type == "warning" else []).append(m.text))
    pg.on("pageerror", lambda e: errors.append(str(e)))

    print("\n==================================================================", flush=True)
    print("   INKWELL MILESTONE 1 ADVERSARIAL CHALLENGER STRESS SUITE", flush=True)
    print("==================================================================", flush=True)

    pg.goto(URL)
    pg.wait_for_timeout(500)

    welcome_btn = pg.locator("#btnWelcomeNewNote")
    if welcome_btn.count() > 0 and welcome_btn.is_visible():
        welcome_btn.click()
        pg.wait_for_timeout(300)

    # -------------------------------------------------------------
    # 1. TOOL SWITCHING SEQUENCE STRESS TEST ACROSS ALL 9 TOOLS
    # -------------------------------------------------------------
    print("\n--- [Section 1] Tool Switching Sequences & State Machine Stress ---", flush=True)

    # Sequence: Pen -> Eraser -> Spacebar Tap -> Lasso -> Spacebar Tap -> Highlighter
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('eraser')")
    check("1.1 active is eraser and lastActiveTool is pen",
          pg.evaluate("window.state.activeTool === 'eraser' && window.state.lastActiveTool === 'pen'"))

    pg.keyboard.down("Space")
    pg.wait_for_timeout(40)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(40)
    check("1.2 quick space tap toggles eraser -> pen and records lastActiveTool=eraser",
          pg.evaluate("window.state.activeTool === 'pen' && window.state.lastActiveTool === 'eraser'"))

    pg.evaluate("window.toolManager.setTool('lasso')")
    check("1.3 switch to lasso sets active=lasso, lastActive=pen",
          pg.evaluate("window.state.activeTool === 'lasso' && window.state.lastActiveTool === 'pen'"))

    pg.keyboard.down("Space")
    pg.wait_for_timeout(40)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(40)
    check("1.4 quick space tap toggles lasso -> pen and records lastActiveTool=lasso",
          pg.evaluate("window.state.activeTool === 'pen' && window.state.lastActiveTool === 'lasso'"))

    pg.evaluate("window.toolManager.setTool('highlighter')")
    check("1.5 switch to highlighter sets active=highlighter, lastActive=pen",
          pg.evaluate("window.state.activeTool === 'highlighter' && window.state.lastActiveTool === 'pen'"))

    pg.keyboard.down("Space")
    pg.wait_for_timeout(40)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(40)
    check("1.6 quick space tap toggles highlighter -> pen and records lastActiveTool=highlighter",
          pg.evaluate("window.state.activeTool === 'pen' && window.state.lastActiveTool === 'highlighter'"))

    pg.keyboard.down("Space")
    pg.wait_for_timeout(40)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(40)
    check("1.7 second quick space tap toggles pen -> highlighter",
          pg.evaluate("window.state.activeTool === 'highlighter' && window.state.lastActiveTool === 'pen'"))

    # Rapid oscillation test: 10 rapid spacebar taps
    all_oscillations_valid = True
    expected = ["pen", "highlighter"]
    for i in range(10):
        pg.keyboard.down("Space")
        pg.wait_for_timeout(30)
        pg.keyboard.up("Space")
        pg.wait_for_timeout(30)
        curr = pg.evaluate("window.state.activeTool")
        expected_tool = expected[i % 2]
        if curr != expected_tool:
            all_oscillations_valid = False
            break
    check("1.8 rapid 10-tap spacebar oscillation maintains deterministic alternating tool state", all_oscillations_valid)

    # Edge Case: Switching to the same tool multiple times should NOT clobber lastActiveTool
    pg.evaluate("window.toolManager.setTool('laser')")
    pg.evaluate("window.toolManager.setTool('laser')")
    check("1.9 selecting identical tool does not overwrite lastActiveTool",
          pg.evaluate("window.state.activeTool === 'laser' && window.state.lastActiveTool !== 'laser'"))

    # Spring-key 'e' interaction
    pg.evaluate("window.toolManager.setTool('laser')")
    pg.evaluate("window.toolManager.handleSpringKeyDown('e')")
    check("1.10 spring key 'e' down temporarily switches tool to eraser",
          pg.evaluate("window.state.activeTool === 'eraser' && window.state.prevTool === 'laser'"))
    pg.evaluate("window.toolManager.handleSpringKeyUp('e')")
    check("1.11 spring key 'e' up restores tool to laser",
          pg.evaluate("window.state.activeTool === 'laser'"))

    # Blur cancel test
    pg.evaluate("window.toolManager.setTool('rect')")
    pg.evaluate("window.toolManager.handleSpaceKeyDown()")
    check("1.12 spacebar down activates pan mode", pg.evaluate("window.state.activeTool === 'pan'"))
    pg.evaluate("window.toolManager.cancelSpringKeys()")
    check("1.13 cancelSpringKeys (e.g. on window blur) restores previous tool cleanly",
          pg.evaluate("window.state.activeTool === 'rect' && !window.state.isSpacePressed"))

    # Spacebar hold without panning (duration >= 250ms)
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('highlighter')")
    pg.keyboard.down("Space")
    pg.wait_for_timeout(300)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    check("1.14 spacebar hold (>=250ms) without panning reverts to toolBefore (highlighter), does NOT toggle",
          pg.evaluate("window.state.activeTool === 'highlighter' && window.state.lastActiveTool === 'pen'"))

    # -------------------------------------------------------------
    # 2. PDF TEXT SELECTION, CASING INTEGRITY & CLIPBOARD
    # -------------------------------------------------------------
    print("\n--- [Section 2] PDF Text Selection, Casing Integrity & Clipboard ---", flush=True)

    # 2.1 Dock button activation & styling
    pg.locator("#btnDockTextSelect").click(force=True)
    pg.wait_for_timeout(50)
    act_tool_val = pg.evaluate("window.state.activeTool")
    btn_dock_active = pg.evaluate("document.getElementById('btnDockTextSelect').classList.contains('active')")
    check("2.1 textSelect dock button receives active class in toolbar UI",
          btn_dock_active,
          f"activeTool='{act_tool_val}', btnHasActiveClass={btn_dock_active} (BUG: toolbar.js looks up 'textSelect' key, activeTool is 'textselect')")

    # 2.2 End-to-end canvas text drag selection
    pg.evaluate("import('./js/workspace/text-selection.js').then(ts => ts.ensurePageTextData(0))")
    pg.wait_for_timeout(100)

    screen_pt = pg.evaluate("""
    (() => {
      const vp = window.getViewport();
      const pl = vp.getPageLayout(0);
      const s0 = vp.worldToScreen(pl.x + 55, pl.y + 60, 'left');
      const s1 = vp.worldToScreen(pl.x + 110, pl.y + 60, 'left');
      const stageRect = document.getElementById('wet').getBoundingClientRect();
      return {
        x0: stageRect.left + s0[0],
        y0: stageRect.top + s0[1],
        x1: stageRect.left + s1[0],
        y1: stageRect.top + s1[1]
      };
    })()
    """)
    pg.mouse.move(screen_pt["x0"], screen_pt["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(screen_pt["x1"], screen_pt["y1"])
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(100)

    has_selected_text = pg.evaluate("!!(window.state.textSelection && window.state.selectedTextString)")
    check("2.2 canvas mouse drag creates text selection range",
          has_selected_text,
          f"textSelection={pg.evaluate('window.state.textSelection')} (BUG: main.js checks tool === 'textSelect', activeTool is 'textselect')")

    pop_visible_e2e = pg.evaluate("!document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("2.3 textSelectionPopover is displayed on canvas text selection",
          pop_visible_e2e,
          f"popoverVisible={pop_visible_e2e} (BUG: updateTextSelectionPopover checks state.activeTool === 'textSelect')")

    # 2.4 Ctrl+C shortcut execution with text selection
    pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      const sel = ts.computeTextSelectionRanges(0, 0, 6); // 'InkWell'
      window.state.textSelection = sel;
      window.state.selectedTextString = sel ? sel.text : '';
    })
    """)
    pg.wait_for_timeout(50)
    pg.keyboard.press("Control+c")
    pg.wait_for_timeout(100)
    copied_ctrl_c = pg.evaluate("navigator.clipboard.readText()")
    check("2.4 Ctrl+C copies selected text to clipboard",
          copied_ctrl_c == "InkWell",
          f"copied='{copied_ctrl_c}' (BUG: edit.copy command checks state.activeTool === 'textSelect')")

    # 2.5 Text selection algorithms (unit isolation)
    word_sel = pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      await ts.ensurePageTextData(0);
      const w = ts.expandSelectionToWord(0, 3);
      return w ? w.text : '';
    })
    """)
    check("2.5 expandSelectionToWord extracts full word", word_sel == "InkWell", f"word='{word_sel}'")

    line_sel = pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      const l = ts.expandSelectionToLine(0, 3);
      return l ? l.text : '';
    })
    """)
    check("2.6 expandSelectionToLine extracts full line", "InkWell Adversarial" in line_sel, f"line='{line_sel}'")

    # -------------------------------------------------------------
    # 3. RADIAL MENU CLICKING & ESC CLOSING
    # -------------------------------------------------------------
    print("\n--- [Section 3] Radial Menu Clicking & Dismissal Behaviors ---", flush=True)

    # 3.1 Clamping at screen edges
    pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(-50, -50))")
    pg.wait_for_timeout(50)
    coords_tl = pg.evaluate("""
    (() => {
      const menu = document.getElementById('radialMenu');
      return { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top) };
    })()
    """)
    check("3.1 radial menu top-left position is clamped >= 10px",
          coords_tl["left"] >= 10 and coords_tl["top"] >= 10, str(coords_tl))

    pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(5000, 5000))")
    pg.wait_for_timeout(50)
    coords_br = pg.evaluate("""
    (() => {
      const menu = document.getElementById('radialMenu');
      return { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top), winW: window.innerWidth, winH: window.innerHeight };
    })()
    """)
    check("3.2 radial menu bottom-right position is clamped within viewport",
          coords_br["left"] <= coords_br["winW"] - 190 and coords_br["top"] <= coords_br["winH"] - 190, str(coords_br))

    # 3.3 Escape dismissal
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(50)
    check("3.3 Escape key closes radial menu",
          pg.evaluate("document.getElementById('radialMenu').classList.contains('hidden')"))

    # 3.4 Radial tool switching items
    radial_tools_ok = True
    for t in ['pen', 'highlighter', 'eraser', 'lasso']:
        pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(400, 400))")
        pg.wait_for_timeout(50)
        item = pg.locator(f".radial-item[data-tool='{t}']")
        item.click(force=True)
        pg.wait_for_timeout(50)
        act = pg.evaluate("window.state.activeTool")
        hidden = pg.evaluate("document.getElementById('radialMenu').classList.contains('hidden')")
        if act != t or not hidden:
            radial_tools_ok = False
            break
    check("3.4 clicking radial tool items switches activeTool and hides menu", radial_tools_ok)

    # 3.5 Radial action item 'palette'
    pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(400, 400))")
    pg.wait_for_timeout(50)
    pg.locator(".radial-item[data-action='palette']").click(force=True)
    pg.wait_for_timeout(50)
    pal_open = pg.evaluate("!document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    rad_hidden = pg.evaluate("document.getElementById('radialMenu').classList.contains('hidden')")
    check("3.5 clicking radial palette action opens Command Palette and hides radial menu",
          pal_open and rad_hidden)
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(50)

    # 3.6 Outside click dismissal
    pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(400, 400))")
    pg.wait_for_timeout(50)
    pg.mouse.click(50, 50)
    pg.wait_for_timeout(50)
    check("3.6 clicking outside dismisses radial menu",
          pg.evaluate("document.getElementById('radialMenu').classList.contains('hidden')"))

    # -------------------------------------------------------------
    # 4. COMMAND PALETTE BOUNDARY CONDITIONS & SEARCH
    # -------------------------------------------------------------
    print("\n--- [Section 4] Command Palette Boundary Conditions & Navigation ---", flush=True)

    pg.keyboard.press("Control+k")
    pg.wait_for_timeout(100)
    total_cmds = pg.evaluate("document.querySelectorAll('.cmd-item').length")
    check("4.1 Ctrl+K opens Command Palette with registered commands", total_cmds > 5, f"total={total_cmds}")

    idx0 = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("4.2 initial selected command index is 0", idx0 == "0")

    pg.keyboard.press("ArrowUp")
    pg.wait_for_timeout(50)
    idx_up = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("4.3 ArrowUp on first item wraps around to last item (boundary)",
          idx_up == str(total_cmds - 1), f"index={idx_up} expected={total_cmds - 1}")

    pg.keyboard.press("ArrowDown")
    pg.wait_for_timeout(50)
    idx_down = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("4.4 ArrowDown on last item wraps around to first item (boundary)",
          idx_down == "0", f"index={idx_down}")

    pg.locator("#cmdPaletteInput").fill("highlighter")
    pg.wait_for_timeout(50)
    filtered_items = pg.evaluate("document.querySelectorAll('.cmd-item').length")
    filtered_idx = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("4.5 typing search query filters results and resets selection to 0",
          filtered_items >= 1 and filtered_idx == "0")

    pg.evaluate("window.toolManager.setTool('pen')")
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(100)
    active_after_enter = pg.evaluate("window.state.activeTool")
    palette_hidden = pg.evaluate("document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    check("4.6 pressing Enter executes selected command and closes palette",
          active_after_enter == "highlighter" and palette_hidden)

    # Empty search query boundary
    pg.keyboard.press("Control+k")
    pg.wait_for_timeout(50)
    pg.locator("#cmdPaletteInput").fill("NONEXISTENT_XYZ_TEST_QUERY")
    pg.wait_for_timeout(50)
    empty_present = pg.evaluate("!!document.querySelector('.cmd-empty-state')")
    pg.keyboard.press("ArrowUp")
    pg.keyboard.press("ArrowDown")
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(50)
    check("4.7 empty search query shows notice and handles arrow keys safely without exception",
          empty_present and len(errors) == 0)

    # Backdrop click dismissal
    pg.evaluate("document.getElementById('cmdPaletteModal').click()")
    pg.wait_for_timeout(50)
    check("4.8 clicking modal backdrop closes Command Palette",
          pg.evaluate("document.getElementById('cmdPaletteModal').classList.contains('hidden')"))

    # -------------------------------------------------------------
    # 5. CONSOLE & WARNING HYGIENE
    # -------------------------------------------------------------
    print("\n--- [Section 5] Console & Diagnostic Hygiene ---", flush=True)
    check("5.1 zero console errors throughout entire stress session", not errors, str(errors[:3]))
    inkwell_warnings = [w for w in warnings if "[inkwell/" in w]
    check("5.2 zero internal inkwell warnings", not inkwell_warnings, str(inkwell_warnings[:3]))

    b.close()

passed = sum(results)
total = len(results)
print(f"\n{'='*66}\n  {passed}/{total} stress checks passed ({len(findings)} failures identified)\n{'='*66}", flush=True)
if findings:
    print("\nAdversarial Findings Summary:")
    for f in findings:
        print(f"  - {f}")

sys.exit(0 if all(results) else 1)
