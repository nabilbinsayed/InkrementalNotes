import math, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "src" / "index.html").as_uri()
errors, warnings = [], []
results = []

def check(name, cond, note=""):
    results.append(bool(cond))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"   {note}" if note else ""), flush=True)

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
    ctx = b.new_context(viewport={"width": 1360, "height": 860}, permissions=["clipboard-read", "clipboard-write"])
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
      open_pdf: async (args) => ({ page_infos: [{ page_index: 0, width_pt: 595.0, height_pt: 842.0 }, { page_index: 1, width_pt: 595.0, height_pt: 842.0 }], outline: [] }),
      create_blank_document: async (args) => ({ page_infos: [{ page_index: 0, width_pt: 595.0, height_pt: 842.0 }, { page_index: 1, width_pt: 595.0, height_pt: 842.0 }], outline: [] }),
      search_pdf: async (args) => [],
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

    print("\n=== Milestone 1 Interactive Verification ===", flush=True)
    pg.goto(URL)
    pg.wait_for_timeout(500)

    welcome_btn = pg.locator("#btnWelcomeNewNote")
    if welcome_btn.count() > 0 and welcome_btn.is_visible():
        welcome_btn.click()
        pg.wait_for_timeout(300)

    # 1. Test Spacebar Quick-Toggle
    print("\n--- Test Spacebar Quick-Toggle ---", flush=True)
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('highlighter')")
    last_active = pg.evaluate("window.state.lastActiveTool")
    check("lastActiveTool is pen after switching to highlighter", last_active == "pen", f"lastActive={last_active}")

    # Tap Spacebar (<250ms)
    pg.keyboard.down("Space")
    tool_during_space = pg.evaluate("window.state.activeTool")
    check("holding space sets activeTool to pan", tool_during_space == "pan", f"tool={tool_during_space}")
    pg.wait_for_timeout(50)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_space = pg.evaluate("window.state.activeTool")
    check("quick-tap space toggles to pen", tool_after_space == "pen", f"tool={tool_after_space}")

    # Tap Spacebar again -> toggles back to highlighter
    pg.keyboard.down("Space")
    pg.wait_for_timeout(50)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_second_space = pg.evaluate("window.state.activeTool")
    check("second quick-tap space toggles back to highlighter", tool_after_second_space == "highlighter", f"tool={tool_after_second_space}")

    # 2. Test Spacebar Hold & Pan
    print("\n--- Test Spacebar Hold & Pan ---", flush=True)
    init_pan_x = pg.evaluate("window.getViewport().panX")
    pg.keyboard.down("Space")
    pg.wait_for_timeout(100)
    box = pg.locator("#wet").bounding_box()
    cx, cy = box["x"] + 300, box["y"] + 300
    pg.mouse.move(cx, cy)
    pg.mouse.down()
    pg.mouse.move(cx - 100, cy)
    pg.mouse.up()
    pg.wait_for_timeout(100)
    new_pan_x = pg.evaluate("window.getViewport().panX")
    check("dragging during space hold updates viewport panX", new_pan_x != init_pan_x, f"init={init_pan_x} new={new_pan_x}")
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    restored_tool = pg.evaluate("window.state.activeTool")
    check("releasing space after pan restores tool to highlighter", restored_tool == "highlighter", f"tool={restored_tool}")

    # 3. Test Left-Click Pan when Tool is 'pan'
    print("\n--- Test Left-Click Pan Tool ---", flush=True)
    pg.evaluate("window.toolManager.setTool('pan')")
    cur_pan_x = pg.evaluate("window.getViewport().panX")
    pg.mouse.move(cx, cy)
    pg.mouse.down()
    pg.mouse.move(cx + 80, cy)
    pg.mouse.up()
    pg.wait_for_timeout(50)
    moved_pan_x = pg.evaluate("window.getViewport().panX")
    check("left click drag in pan tool updates panX", moved_pan_x != cur_pan_x, f"cur={cur_pan_x} moved={moved_pan_x}")

    # 4. Test Text Selection, Toolbar Active State, Dragging & Clipboard
    print("\n--- Test Text Selection ---", flush=True)
    pg.locator("#btnDockTextSelect").click(force=True)
    pg.wait_for_timeout(50)
    act_tool = pg.evaluate("window.state.activeTool")
    btn_active = pg.evaluate("document.getElementById('btnDockTextSelect').classList.contains('active')")
    check("clicking textSelect dock button sets activeTool to 'textSelect'", act_tool == "textSelect", f"activeTool={act_tool}")
    check("textSelect dock button has active CSS class", btn_active)

    # Preload page text data
    pg.evaluate("import('./js/workspace/text-selection.js').then(ts => ts.ensurePageTextData(0))")
    pg.wait_for_timeout(100)

    # Drag across text on #wet canvas
    screen_pt = pg.evaluate("""
    (() => {
      const vp = window.getViewport();
      const pl = vp.getPageLayout(0);
      const s0 = vp.worldToScreen(pl.x + 55, pl.y + 60, 'left');
      const s1 = vp.worldToScreen(pl.x + 160, pl.y + 60, 'left');
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

    has_sel = pg.evaluate("!!(window.state.textSelection && window.state.selectedTextString)")
    drag_text = pg.evaluate("window.state.selectedTextString || ''")
    check("canvas mouse drag creates populated textSelection range", has_sel and len(drag_text) > 0, f"text='{drag_text}'")

    pop_visible = pg.evaluate("!document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("textSelectionPopover is visible after canvas drag selection", pop_visible)

    # Copy via Ctrl+C shortcut
    pg.keyboard.press("Control+c")
    pg.wait_for_timeout(100)
    copied = pg.evaluate("navigator.clipboard.readText()")
    check("Ctrl+C copies canvas drag-selected text to clipboard", copied == drag_text and len(copied) > 0, f"copied='{copied}'")

    # Multi-line character range selection unit logic
    pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      await ts.ensurePageTextData(0);
      const sel = ts.computeTextSelectionRanges(0, 0, 16);
      window.state.textSelection = sel;
      window.state.selectedTextString = sel ? sel.text : '';
    })
    """)
    pg.wait_for_timeout(100)
    sel_text = pg.evaluate("window.state.selectedTextString")
    check("multi-line character range selection includes both lines accurately",
          "Hello InkWell" in sel_text and "Sec" in sel_text, f"selected={sel_text}")

    # 5. Test Canvas Context Menu
    print("\n--- Test Context Menu ---", flush=True)
    pg.locator("#wet").click(button="right", position={"x": 200, "y": 200})
    pg.wait_for_timeout(100)
    ctx_hidden = pg.evaluate("document.getElementById('canvasContextMenu').classList.contains('hidden')")
    check("right click canvas opens context menu", not ctx_hidden)

    # Click outside closes context menu
    pg.mouse.click(box["x"] + 10, box["y"] + 10)
    pg.wait_for_timeout(50)
    ctx_closed = pg.evaluate("document.getElementById('canvasContextMenu').classList.contains('hidden')")
    check("clicking outside closes context menu", ctx_closed)

    # 6. Test Radial Menu
    print("\n--- Test Radial Menu ---", flush=True)
    pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(300, 300))")
    pg.wait_for_timeout(50)
    radial_hidden = pg.evaluate("document.getElementById('radialMenu').classList.contains('hidden')")
    check("showRadialMenu displays radial menu", not radial_hidden)

    # Click radial item (e.g. Eraser)
    eraser_item = pg.locator(".radial-item[data-tool='eraser']")
    check("radial-item with data-tool='eraser' exists", eraser_item.count() == 1)
    eraser_item.click(force=True)
    pg.wait_for_timeout(50)
    active_after_radial = pg.evaluate("window.state.activeTool")
    check("clicking radial eraser item switches activeTool to eraser", active_after_radial == "eraser", f"tool={active_after_radial}")

    # 7. Test Command Palette
    print("\n--- Test Command Palette ---", flush=True)
    pg.keyboard.press("Control+K")
    pg.wait_for_timeout(100)
    cmd_hidden = pg.evaluate("document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    check("Ctrl+K opens command palette modal", not cmd_hidden)

    # Test ArrowDown and ArrowUp
    pg.keyboard.press("ArrowDown")
    pg.wait_for_timeout(50)
    first_selected = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("ArrowDown selects next item in command palette", first_selected == "1", f"selected={first_selected}")

    pg.keyboard.press("ArrowUp")
    pg.wait_for_timeout(50)
    reselected = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("ArrowUp moves selection back up", reselected == "0", f"selected={reselected}")

    pg.keyboard.press("Escape")
    pg.wait_for_timeout(50)
    cmd_closed = pg.evaluate("document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    check("Escape key closes command palette", cmd_closed)

    print("\n--- Console & Hygiene Check ---", flush=True)
    check("zero console errors throughout session", not errors, str(errors[:3]))
    inkwell_warnings = [w for w in warnings if "[inkwell/" in w]
    check("zero internal inkwell warnings", not inkwell_warnings, str(inkwell_warnings[:3]))

    b.close()

print(f"\n{'='*62}\n  {sum(results)}/{len(results)} interactive checks passed\n{'='*62}", flush=True)
sys.exit(0 if all(results) else 1)
