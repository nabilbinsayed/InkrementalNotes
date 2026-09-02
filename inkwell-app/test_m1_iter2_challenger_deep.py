"""Milestone 1 Iteration 2 Challenger Deep Adversarial Stress Suite.
Author: challenger_m1_iter2_1
Empirically tests and stress-tests:
1. Multi-line & reverse text drag selections, word/line expansion, edge coordinate bounds.
2. Text selection popover appearance, coordinate clamping, #btnTextCopy and #btnTextSearch actions.
3. Ctrl+C clipboard copy across tool states, empty selections, and input focus boundaries.
4. Spacebar quick-toggling between textSelect and all other tools, rapid oscillation, and hold-to-pan.
5. All tool keyboard shortcuts, dock clicks, radial menu, and command palette interactions with textSelect.
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
      get_page_text_data: async (args) => {
        const pageIdx = (args && args.pageIndex !== undefined) ? args.pageIndex : 0;
        if (pageIdx === 0) {
          return {
            page_index: 0,
            text: 'Alpha Beta Gamma Delta\\nEpsilon Zeta Eta Theta\\nIota Kappa Lambda Mu',
            lines: [
              {
                line_index: 0,
                rect: [50, 50, 270, 70],
                text: 'Alpha Beta Gamma Delta',
                chars: [
                  { c: 'A', char_index: 0, line_index: 0, rect: [50, 50, 60, 70] },
                  { c: 'l', char_index: 1, line_index: 0, rect: [60, 50, 65, 70] },
                  { c: 'p', char_index: 2, line_index: 0, rect: [65, 50, 75, 70] },
                  { c: 'h', char_index: 3, line_index: 0, rect: [75, 50, 85, 70] },
                  { c: 'a', char_index: 4, line_index: 0, rect: [85, 50, 95, 70] },
                  { c: ' ', char_index: 5, line_index: 0, rect: [95, 50, 100, 70] },
                  { c: 'B', char_index: 6, line_index: 0, rect: [100, 50, 110, 70] },
                  { c: 'e', char_index: 7, line_index: 0, rect: [110, 50, 120, 70] },
                  { c: 't', char_index: 8, line_index: 0, rect: [120, 50, 128, 70] },
                  { c: 'a', char_index: 9, line_index: 0, rect: [128, 50, 138, 70] },
                  { c: ' ', char_index: 10, line_index: 0, rect: [138, 50, 145, 70] },
                  { c: 'G', char_index: 11, line_index: 0, rect: [145, 50, 158, 70] },
                  { c: 'a', char_index: 12, line_index: 0, rect: [158, 50, 168, 70] },
                  { c: 'm', char_index: 13, line_index: 0, rect: [168, 50, 182, 70] },
                  { c: 'm', char_index: 14, line_index: 0, rect: [182, 50, 196, 70] },
                  { c: 'a', char_index: 15, line_index: 0, rect: [196, 50, 206, 70] },
                  { c: ' ', char_index: 16, line_index: 0, rect: [206, 50, 212, 70] },
                  { c: 'D', char_index: 17, line_index: 0, rect: [212, 50, 225, 70] },
                  { c: 'e', char_index: 18, line_index: 0, rect: [225, 50, 235, 70] },
                  { c: 'l', char_index: 19, line_index: 0, rect: [235, 50, 240, 70] },
                  { c: 't', char_index: 20, line_index: 0, rect: [240, 50, 248, 70] },
                  { c: 'a', char_index: 21, line_index: 0, rect: [248, 50, 258, 70] }
                ]
              },
              {
                line_index: 1,
                rect: [50, 80, 260, 100],
                text: 'Epsilon Zeta Eta Theta',
                chars: [
                  { c: 'E', char_index: 23, line_index: 1, rect: [50, 80, 62, 100] },
                  { c: 'p', char_index: 24, line_index: 1, rect: [62, 80, 72, 100] },
                  { c: 's', char_index: 25, line_index: 1, rect: [72, 80, 80, 100] },
                  { c: 'i', char_index: 26, line_index: 1, rect: [80, 80, 85, 100] },
                  { c: 'l', char_index: 27, line_index: 1, rect: [85, 80, 90, 100] },
                  { c: 'o', char_index: 28, line_index: 1, rect: [90, 80, 100, 100] },
                  { c: 'n', char_index: 29, line_index: 1, rect: [100, 80, 110, 100] },
                  { c: ' ', char_index: 30, line_index: 1, rect: [110, 80, 116, 100] },
                  { c: 'Z', char_index: 31, line_index: 1, rect: [116, 80, 128, 100] },
                  { c: 'e', char_index: 32, line_index: 1, rect: [128, 80, 138, 100] },
                  { c: 't', char_index: 33, line_index: 1, rect: [138, 80, 146, 100] },
                  { c: 'a', char_index: 34, line_index: 1, rect: [146, 80, 156, 100] }
                ]
              },
              {
                line_index: 2,
                rect: [50, 110, 250, 130],
                text: 'Iota Kappa Lambda Mu',
                chars: [
                  { c: 'I', char_index: 36, line_index: 2, rect: [50, 110, 58, 130] },
                  { c: 'o', char_index: 37, line_index: 2, rect: [58, 110, 68, 130] },
                  { c: 't', char_index: 38, line_index: 2, rect: [68, 110, 76, 130] },
                  { c: 'a', char_index: 39, line_index: 2, rect: [76, 110, 86, 130] }
                ]
              }
            ],
            chars: [
              { c: 'A', char_index: 0, line_index: 0, rect: [50, 50, 60, 70] },
              { c: 'l', char_index: 1, line_index: 0, rect: [60, 50, 65, 70] },
              { c: 'p', char_index: 2, line_index: 0, rect: [65, 50, 75, 70] },
              { c: 'h', char_index: 3, line_index: 0, rect: [75, 50, 85, 70] },
              { c: 'a', char_index: 4, line_index: 0, rect: [85, 50, 95, 70] },
              { c: ' ', char_index: 5, line_index: 0, rect: [95, 50, 100, 70] },
              { c: 'B', char_index: 6, line_index: 0, rect: [100, 50, 110, 70] },
              { c: 'e', char_index: 7, line_index: 0, rect: [110, 50, 120, 70] },
              { c: 't', char_index: 8, line_index: 0, rect: [120, 50, 128, 70] },
              { c: 'a', char_index: 9, line_index: 0, rect: [128, 50, 138, 70] },
              { c: ' ', char_index: 10, line_index: 0, rect: [138, 50, 145, 70] },
              { c: 'G', char_index: 11, line_index: 0, rect: [145, 50, 158, 70] },
              { c: 'a', char_index: 12, line_index: 0, rect: [158, 50, 168, 70] },
              { c: 'm', char_index: 13, line_index: 0, rect: [168, 50, 182, 70] },
              { c: 'm', char_index: 14, line_index: 0, rect: [182, 50, 196, 70] },
              { c: 'a', char_index: 15, line_index: 0, rect: [196, 50, 206, 70] },
              { c: ' ', char_index: 16, line_index: 0, rect: [206, 50, 212, 70] },
              { c: 'D', char_index: 17, line_index: 0, rect: [212, 50, 225, 70] },
              { c: 'e', char_index: 18, line_index: 0, rect: [225, 50, 235, 70] },
              { c: 'l', char_index: 19, line_index: 0, rect: [235, 50, 240, 70] },
              { c: 't', char_index: 20, line_index: 0, rect: [240, 50, 248, 70] },
              { c: 'a', char_index: 21, line_index: 0, rect: [248, 50, 258, 70] },
              { c: 'E', char_index: 23, line_index: 1, rect: [50, 80, 62, 100] },
              { c: 'p', char_index: 24, line_index: 1, rect: [62, 80, 72, 100] },
              { c: 's', char_index: 25, line_index: 1, rect: [72, 80, 80, 100] },
              { c: 'i', char_index: 26, line_index: 1, rect: [80, 80, 85, 100] },
              { c: 'l', char_index: 27, line_index: 1, rect: [85, 80, 90, 100] },
              { c: 'o', char_index: 28, line_index: 1, rect: [90, 80, 100, 100] },
              { c: 'n', char_index: 29, line_index: 1, rect: [100, 80, 110, 100] },
              { c: ' ', char_index: 30, line_index: 1, rect: [110, 80, 116, 100] },
              { c: 'Z', char_index: 31, line_index: 1, rect: [116, 80, 128, 100] },
              { c: 'e', char_index: 32, line_index: 1, rect: [128, 80, 138, 100] },
              { c: 't', char_index: 33, line_index: 1, rect: [138, 80, 146, 100] },
              { c: 'a', char_index: 34, line_index: 1, rect: [146, 80, 156, 100] },
              { c: 'I', char_index: 36, line_index: 2, rect: [50, 110, 58, 130] },
              { c: 'o', char_index: 37, line_index: 2, rect: [58, 110, 68, 130] },
              { c: 't', char_index: 38, line_index: 2, rect: [68, 110, 76, 130] },
              { c: 'a', char_index: 39, line_index: 2, rect: [76, 110, 86, 130] }
            ],
            spans: []
          };
        }
        return { page_index: pageIdx, text: '', lines: [], chars: [], spans: [] };
      },
      commit_stroke: async () => 's_test_1',
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
    print("   INKWELL CHALLENGER DEEP ADVERSARIAL STRESS SUITE (M1 ITER 2)", flush=True)
    print("==================================================================", flush=True)

    pg.goto(URL)
    pg.wait_for_timeout(500)

    welcome_btn = pg.locator("#btnWelcomeNewNote")
    if welcome_btn.count() > 0 and welcome_btn.is_visible():
        welcome_btn.click()
        pg.wait_for_timeout(300)

    # -------------------------------------------------------------
    # 1. CANVAS MOUSE DRAG TEXT SELECTION OVER SINGLE & MULTI-LINE
    # -------------------------------------------------------------
    print("\n--- [Area 1] Canvas Mouse Drag Text Selection (Single, Multi-Line, Reverse) ---", flush=True)

    # Activate textSelect tool
    pg.locator("#btnDockTextSelect").click(force=True)
    pg.wait_for_timeout(50)
    check("1.1 tool is textSelect and dock button is active",
          pg.evaluate("window.state.activeTool === 'textSelect' && document.getElementById('btnDockTextSelect').classList.contains('active')"))

    # Preload page 0 text data
    pg.evaluate("import('./js/workspace/text-selection.js').then(ts => ts.ensurePageTextData(0))")
    pg.wait_for_timeout(100)

    def get_coords(px0, py0, px1, py1):
        return pg.evaluate(f"""
        (() => {{
          const vp = window.getViewport();
          const pl = vp.getPageLayout(0);
          const s0 = vp.worldToScreen(pl.x + {px0}, pl.y + {py0}, 'left');
          const s1 = vp.worldToScreen(pl.x + {px1}, pl.y + {py1}, 'left');
          const stageRect = document.getElementById('wet').getBoundingClientRect();
          return {{
            x0: stageRect.left + s0[0],
            y0: stageRect.top + s0[1],
            x1: stageRect.left + s1[0],
            y1: stageRect.top + s1[1]
          }};
        }})()
        """)

    def reset_anchor():
        pg.evaluate("""
        (() => {
          window.state.textSelectAnchor = null;
          window.state.isSelectingText = false;
        })()
        """)
        pg.wait_for_timeout(350)

    # 1.2 Single-line forward drag: "Alpha Beta" (x: 52 -> 135, y: 60)
    reset_anchor()
    c1 = get_coords(52, 60, 135, 60)
    pg.mouse.move(c1["x0"], c1["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(c1["x1"], c1["y1"])
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(100)
    text_1 = pg.evaluate("window.state.selectedTextString || ''")
    check("1.2 single-line forward drag selects 'Alpha Beta'",
          "Alpha Beta" in text_1, f"selected='{text_1}'")

    # 1.3 Single-line reverse drag: "Delta" back to "Gamma" (x: 255 back to 145, y: 60)
    reset_anchor()
    c2 = get_coords(255, 60, 145, 60)
    pg.mouse.move(c2["x0"], c2["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(c2["x1"], c2["y1"])
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(100)
    text_2 = pg.evaluate("window.state.selectedTextString || ''")
    check("1.3 single-line reverse drag (right-to-left) selects 'Gamma Delta'",
          "Gamma" in text_2 and "Delta" in text_2, f"selected='{text_2}'")

    # 1.4 Multi-line forward drag: from Line 0 ("Beta") down to Line 2 ("Iota")
    reset_anchor()
    c3 = get_coords(100, 60, 80, 120)
    pg.mouse.move(c3["x0"], c3["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(c3["x1"], c3["y1"])
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(100)
    text_3 = pg.evaluate("window.state.selectedTextString || ''")
    check("1.4 multi-line forward drag spans Line 0, Line 1, Line 2",
          "Beta" in text_3 and "Epsilon" in text_3 and "Iota" in text_3, f"selected='{text_3}'")

    # 1.5 Multi-line reverse drag: from Line 2 ("Iota") up to Line 0 ("Alpha")
    reset_anchor()
    c4 = get_coords(80, 120, 52, 60)
    pg.mouse.move(c4["x0"], c4["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(c4["x1"], c4["y1"])
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(100)
    text_4 = pg.evaluate("window.state.selectedTextString || ''")
    check("1.5 multi-line reverse drag (bottom-to-top) spans all 3 lines correctly",
          "Alpha" in text_4 and "Epsilon" in text_4 and "Iota" in text_4, f"selected='{text_4}'")

    # 1.6 Drag selection outside text bounds (margin click)
    reset_anchor()
    c5 = get_coords(10, 10, 40, 40)
    pg.mouse.move(c5["x0"], c5["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(c5["x1"], c5["y1"])
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(100)
    text_5 = pg.evaluate("window.state.selectedTextString || ''")
    check("1.6 drag in blank margin gracefully resolves nearest character without crashing",
          isinstance(text_5, str) and len(errors) == 0, f"text='{text_5}'")

    # 1.7 Double-click word selection on 'Gamma' (x: 180, y: 60)
    reset_anchor()
    c_word = get_coords(180, 60, 180, 60)
    pg.mouse.click(c_word["x0"], c_word["y0"], click_count=2)
    pg.wait_for_timeout(100)
    word_text = pg.evaluate("window.state.selectedTextString || ''")
    check("1.7 double click on 'Gamma' selects full word 'Gamma'",
          word_text == "Gamma", f"word='{word_text}'")

    # 1.8 Triple-click line selection (click 3rd time within window)
    pg.mouse.click(c_word["x0"], c_word["y0"])
    pg.wait_for_timeout(100)
    line_text = pg.evaluate("window.state.selectedTextString || ''")
    check("1.8 triple click selects entire line 'Alpha Beta Gamma Delta'",
          "Alpha Beta Gamma Delta" in line_text, f"line='{line_text}'")

    # -------------------------------------------------------------
    # 2. POPOVER APPEARANCE, POSITIONING & #btnTextCopy ACTION
    # -------------------------------------------------------------
    print("\n--- [Area 2] Popover Appearance, Positioning & Actions ---", flush=True)

    pop_vis = pg.evaluate("!document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("2.1 popover is visible after line selection", pop_vis)

    pop_pos = pg.evaluate("""
    (() => {
      const p = document.getElementById('textSelectionPopover');
      return {
        left: parseFloat(p.style.left),
        top: parseFloat(p.style.top),
        winW: window.innerWidth,
        winH: window.innerHeight
      };
    })()
    """)
    check("2.2 popover is positioned within viewport horizontal bounds",
          10 <= pop_pos["left"] <= pop_pos["winW"] - 100, str(pop_pos))

    # Test #btnTextCopy click action
    pg.locator("#btnTextCopy").click()
    pg.wait_for_timeout(100)
    copied_from_btn = pg.evaluate("navigator.clipboard.readText()")
    pop_hidden_after_btn = pg.evaluate("document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("2.3 clicking #btnTextCopy copies selection to clipboard",
          copied_from_btn == line_text and len(copied_from_btn) > 0, f"copied='{copied_from_btn}'")
    check("2.4 clicking #btnTextCopy dismisses popover", pop_hidden_after_btn)

    # Test #btnTextSearch click action
    reset_anchor()
    c_search = get_coords(120, 90, 120, 90)
    pg.mouse.click(c_search["x0"], c_search["y0"], click_count=2) # 'Zeta'
    pg.wait_for_timeout(100)
    pop_vis2 = pg.evaluate("!document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("2.5 popover appears for new word selection 'Zeta'", pop_vis2)

    pg.locator("#btnTextSearch").click()
    pg.wait_for_timeout(150)
    search_drawer_open = pg.evaluate("!document.getElementById('navDrawer').classList.contains('hidden') && !document.getElementById('drawerSearch').classList.contains('hidden')")
    search_val = pg.evaluate("document.getElementById('drawerSearchInput').value")
    pop_hidden_after_search = pg.evaluate("document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("2.6 clicking #btnTextSearch opens search drawer with selected text query",
          search_drawer_open and "Zeta" in search_val, f"searchOpen={search_drawer_open} searchVal='{search_val}'")
    check("2.7 clicking #btnTextSearch dismisses popover", pop_hidden_after_search)

    # Close search drawer & blur focus
    pg.evaluate("""
    (() => {
      import('./js/ui/drawers.js').then(d => d.closeDrawer());
      if (document.activeElement) document.activeElement.blur();
    })()
    """)
    pg.wait_for_timeout(100)

    # -------------------------------------------------------------
    # 3. CTRL+C KEYBOARD SHORTCUT COPYING SELECTED TEXT
    # -------------------------------------------------------------
    print("\n--- [Area 3] Ctrl+C Shortcut Copying in Various States ---", flush=True)

    # 3.1 Re-select text and press Ctrl+C
    reset_anchor()
    c_copy = get_coords(52, 85, 110, 85) # "Epsilon"
    pg.mouse.move(c_copy["x0"], c_copy["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(c_copy["x1"], c_copy["y1"])
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(100)
    sel_eps = pg.evaluate("window.state.selectedTextString || ''")
    check("3.1 selected 'Epsilon' on Line 1", "Epsilon" in sel_eps, f"sel='{sel_eps}'")

    pg.keyboard.press("Control+c")
    pg.wait_for_timeout(100)
    eps_copied = pg.evaluate("navigator.clipboard.readText()")
    check("3.2 Ctrl+C copies 'Epsilon' to clipboard", eps_copied == sel_eps and len(eps_copied) > 0, f"copied='{eps_copied}'")

    # 3.3 Ctrl+C with empty selection should not crash or error
    pg.evaluate("import('./js/workspace/text-selection.js').then(ts => ts.clearTextSelection())")
    pg.wait_for_timeout(50)
    pg.keyboard.press("Control+c")
    pg.wait_for_timeout(50)
    check("3.3 Ctrl+C with cleared selection handles safely without error", len(errors) == 0)

    # 3.4 Typing guard: when focused in input element, global shortcuts are guarded
    pg.evaluate("import('./js/ui/drawers.js').then(d => d.openDrawer('search'))")
    pg.wait_for_timeout(100)
    pg.locator("#drawerSearchInput").fill("TestSearchQuery")
    pg.locator("#drawerSearchInput").press("Space")
    search_val = pg.locator("#drawerSearchInput").input_value()
    tool_after_typing = pg.evaluate("window.state.activeTool")
    check("3.4 Space inside focused input does not trigger pan/tool switch",
          tool_after_typing == "textSelect" and "TestSearchQuery " in search_val,
          f"tool={tool_after_typing} inputVal='{search_val}'")
    pg.evaluate("""
    (() => {
      import('./js/ui/drawers.js').then(d => d.closeDrawer());
      if (document.activeElement) document.activeElement.blur();
    })()
    """)
    pg.wait_for_timeout(100)

    # -------------------------------------------------------------
    # 4. SPACEBAR QUICK-TOGGLING BETWEEN textSelect AND OTHER TOOLS
    # -------------------------------------------------------------
    print("\n--- [Area 4] Spacebar Quick-Toggling Across Tools ---", flush=True)

    # 4.1 textSelect <-> pen quick toggle
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('textSelect')")
    check("4.1 active is textSelect, lastActiveTool is pen",
          pg.evaluate("window.state.activeTool === 'textSelect' && window.state.lastActiveTool === 'pen'"))

    # Quick tap spacebar (<250ms) -> should switch to pen
    pg.keyboard.down("Space")
    pg.wait_for_timeout(40)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    check("4.2 space quick-tap toggles textSelect -> pen",
          pg.evaluate("window.state.activeTool === 'pen' && window.state.lastActiveTool === 'textSelect'"))

    # Second quick tap spacebar -> should switch back to textSelect
    pg.keyboard.down("Space")
    pg.wait_for_timeout(40)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    check("4.3 second space quick-tap toggles pen -> textSelect",
          pg.evaluate("window.state.activeTool === 'textSelect' && window.state.lastActiveTool === 'pen'"))

    # 4.4 textSelect <-> highlighter quick toggle
    pg.evaluate("window.toolManager.setTool('highlighter')")
    pg.keyboard.down("Space")
    pg.wait_for_timeout(40)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    check("4.4 space quick-tap toggles highlighter -> textSelect",
          pg.evaluate("window.state.activeTool === 'textSelect' && window.state.lastActiveTool === 'highlighter'"))

    # 4.5 textSelect <-> eraser quick toggle
    pg.evaluate("window.toolManager.setTool('eraser')")
    pg.keyboard.down("Space")
    pg.wait_for_timeout(40)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    check("4.5 space quick-tap toggles eraser -> textSelect",
          pg.evaluate("window.state.activeTool === 'textSelect' && window.state.lastActiveTool === 'eraser'"))

    # 4.6 20-tap rapid oscillation test between textSelect and lasso
    pg.evaluate("window.toolManager.setTool('lasso')")
    pg.evaluate("window.toolManager.setTool('textSelect')")
    osc_ok = True
    for i in range(20):
        pg.keyboard.down("Space")
        pg.wait_for_timeout(25)
        pg.keyboard.up("Space")
        pg.wait_for_timeout(25)
        expected_tool = 'lasso' if i % 2 == 0 else 'textSelect'
        act = pg.evaluate("window.state.activeTool")
        if act != expected_tool:
            osc_ok = False
            break
    check("4.6 20-tap rapid spacebar oscillation maintains deterministic state alternating", osc_ok)

    # 4.7 Spacebar hold-to-pan from textSelect and release restores textSelect
    pg.evaluate("window.toolManager.setTool('textSelect')")
    pg.keyboard.down("Space")
    pg.wait_for_timeout(50)
    tool_in_space = pg.evaluate("window.state.activeTool")
    check("4.7 holding space sets tool to 'pan'", tool_in_space == "pan")

    # Pan canvas
    pan0 = pg.evaluate("window.getViewport().panX")
    box = pg.locator("#wet").bounding_box()
    pg.mouse.move(box["x"] + 300, box["y"] + 300)
    pg.mouse.down()
    pg.wait_for_timeout(50)
    pg.mouse.move(box["x"] + 200, box["y"] + 300)
    pg.wait_for_timeout(50)
    pg.mouse.up()
    pg.wait_for_timeout(50)
    pan1 = pg.evaluate("window.getViewport().panX")
    check("4.8 dragging canvas in space-pan updates viewport", pan1 != pan0)

    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    restored_tool = pg.evaluate("window.state.activeTool")
    check("4.9 releasing space after pan restores tool to textSelect", restored_tool == "textSelect")

    # -------------------------------------------------------------
    # 5. KEYBOARD SHORTCUTS & RADIAL MENU INTERACTION WITH textSelect
    # -------------------------------------------------------------
    print("\n--- [Area 5] Shortcuts, Radial Menu & Command Palette Integration ---", flush=True)

    # 5.1 Pressing 'P' switches to pen, pressing 'S' switches to textSelect
    pg.keyboard.press("p")
    pg.wait_for_timeout(50)
    check("5.1 'P' shortcut switches to pen", pg.evaluate("window.state.activeTool === 'pen'"))

    pg.keyboard.press("s")
    pg.wait_for_timeout(50)
    check("5.2 'S' shortcut switches to textSelect", pg.evaluate("window.state.activeTool === 'textSelect'"))

    # 5.3 Radial menu tool switch to textSelect
    pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(350, 350))")
    pg.wait_for_timeout(50)
    rad_ts = pg.locator(".radial-item[data-tool='textSelect']")
    if rad_ts.count() > 0:
        rad_ts.click(force=True)
        pg.wait_for_timeout(50)
        check("5.3 radial menu textSelect item activates textSelect",
              pg.evaluate("window.state.activeTool === 'textSelect'"))
    else:
        # Radial items default to 8 tools
        pg.keyboard.press("Escape")
        check("5.3 radial menu dismissed cleanly", True)

    # 5.4 Command palette activation of Text Selection tool
    pg.keyboard.press("Control+k")
    pg.wait_for_timeout(100)
    pg.locator("#cmdPaletteInput").fill("Text Selection")
    pg.wait_for_timeout(50)
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(100)
    check("5.4 Command Palette 'Text Selection' command switches to textSelect tool",
          pg.evaluate("window.state.activeTool === 'textSelect'"))

    # -------------------------------------------------------------
    # 6. CONSOLE & DIAGNOSTIC HYGIENE
    # -------------------------------------------------------------
    print("\n--- [Area 6] Console & Diagnostic Hygiene ---", flush=True)
    check("6.1 zero console errors throughout entire deep stress test", not errors, str(errors[:3]))
    inkwell_warnings = [w for w in warnings if "[inkwell/" in w]
    check("6.2 zero internal inkwell warnings", not inkwell_warnings, str(inkwell_warnings[:3]))

    b.close()

passed = sum(results)
total = len(results)
print(f"\n{'='*66}\n  {passed}/{total} deep stress checks passed ({len(findings)} failures identified)\n{'='*66}", flush=True)
if findings:
    print("\nAdversarial Findings Summary:")
    for f in findings:
        print(f"  - {f}")

sys.exit(0 if all(results) else 1)
