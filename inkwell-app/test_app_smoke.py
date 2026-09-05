"""Smoke test for InkWell production desktop frontend (inkwell-app).
Consolidated verification suite for all interaction, ergonomics, and accessibility requirements:
- T1: Boot & ES Module Loading (triple canvas, stage, Tauri stub)
- T2: Tool Switching & State Machine (9 dock tools + tool history tracking)
- T3: Spacebar Quick-Toggle & Hold-to-Pan (quick tap toggle, hold pan, left-click pan)
- T4: PDF Text Selection, Highlights & Clipboard (drag selection, popover, Ctrl+C, multi-line)
- T5: Canvas Context Menu & Tool Triggering (right-click trigger, actions, click-outside dismissal)
- T6: Radial Tool Menu (.radial-item query selector & tool switching)
- T7: Command Palette (Ctrl+K opening, ArrowDown/ArrowUp navigation, Escape dismissal)
- T8: Touch Target & Accessibility Ergonomics (>=44x44px hit expansion, :focus-visible, toasts ARIA)
- T9: Navigation Rail & Drawer Panels (Thumbnails, Outline, Search, DocInfo, Page Insertion)
- T10: Synthetic Pen Input Pipeline (CDP mouse/pen input, state commit, dry canvas composite)
- T11: Zoom Controls & Percentage Readout
- T12: WAL Undo/Redo IPC Synchronization (Image, Text & Batch Mutations)
- T13: Document Text Layer Isolation & Page Shift Cache
- T14: Console Hygiene (0 errors, 0 internal warnings)
"""
import math, pathlib, sys, time
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

    # Enhanced Tauri invoke stub with dynamic tile rendering and rich PDF text layer
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
      insert_blank_page: async (args) => true,
      journal_image_mutation: async (args) => {
        window.__walImageMutations = window.__walImageMutations || [];
        window.__walImageMutations.push(args);
        return true;
      },
      journal_text_mutation: async (args) => {
        window.__walTextMutations = window.__walTextMutations || [];
        window.__walTextMutations.push(args);
        return true;
      },
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

    # -------------------------------------------------------------
    # T1: Boot & ES Module Loading
    # -------------------------------------------------------------
    print("\n=== T1  Boot & ES Module Loading ===", flush=True)
    pg.goto(URL)
    pg.wait_for_timeout(500)

    check("page loads with no JS errors", not errors, str(errors[:2]))
    check("triple canvases initialized",
          pg.evaluate("!!(document.getElementById('tiles') && document.getElementById('dry') && document.getElementById('wet'))"))
    check("stage element mounted",
          pg.evaluate("document.getElementById('stage').clientWidth > 400"))
    check("Tauri invoke stub connected",
          pg.evaluate("!!(window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function')"))

    # Initialize a new whiteboard document if welcome overlay is active
    welcome_btn = pg.locator("#btnWelcomeNewNote")
    if welcome_btn.count() > 0 and welcome_btn.is_visible():
        welcome_btn.click()
        pg.wait_for_timeout(300)

    # -------------------------------------------------------------
    # T2: Tool Switching & State Machine
    # -------------------------------------------------------------
    print("\n=== T2  Tool Switching & State Machine ===", flush=True)
    tool_buttons = [
        ('btnDockPen', 'pen'),
        ('btnDockHighlighter', 'highlighter'),
        ('btnDockEraser', 'eraser'),
        ('btnDockLasso', 'lasso'),
        ('btnDockTextSelect', 'textSelect'),
        ('btnDockShapes', 'rect'),
        ('btnDockText', 'text'),
        ('btnDockLaser', 'laser'),
        ('btnDockPan', 'pan'),
    ]
    tool_switch_ok = True
    for btn_id, expected_tool in tool_buttons:
        btn = pg.locator(f"#{btn_id}")
        if btn.count() != 1:
            tool_switch_ok = False
            check(f"dock button #{btn_id} exists", False, f"found count={btn.count()}")
            continue
        btn.click(force=True)
        pg.wait_for_timeout(40)
        active = pg.evaluate("window.state.activeTool")
        has_active_cls = pg.evaluate(f"document.getElementById('{btn_id}').classList.contains('active')")
        if str(active).lower() != expected_tool.lower() or not has_active_cls:
            tool_switch_ok = False
            check(f"tool switch to {expected_tool}", False, f"actual={active}, hasClass={has_active_cls}")
    if tool_switch_ok:
        check("all 9 dock tools toggle with correct state machine mapping and active CSS class", True)

    # Tool history tracking verification
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('highlighter')")
    last_act_1 = pg.evaluate("window.state.lastActiveTool")
    check("tool history tracks pen as lastActiveTool after switching to highlighter", last_act_1 == "pen", f"actual={last_act_1}")

    pg.evaluate("window.toolManager.setTool('eraser')")
    last_act_2 = pg.evaluate("window.state.lastActiveTool")
    check("tool history tracks highlighter as lastActiveTool after switching to eraser", last_act_2 == "highlighter", f"actual={last_act_2}")

    # -------------------------------------------------------------
    # T3: Spacebar Quick-Toggle & Hold-to-Pan
    # -------------------------------------------------------------
    print("\n=== T3  Spacebar Quick-Toggle & Hold-to-Pan ===", flush=True)
    # 1. Quick tap (<250ms) toggles between current tool (eraser) and last active tool (highlighter)
    pg.keyboard.down("Space")
    tool_during_space = pg.evaluate("window.state.activeTool")
    check("pressing Space engages pan mode", tool_during_space == "pan", f"tool={tool_during_space}")
    pg.wait_for_timeout(50)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_tap = pg.evaluate("window.state.activeTool")
    check("quick-tap Space (<250ms) toggles to last active tool (highlighter)", tool_after_tap == "highlighter", f"tool={tool_after_tap}")

    # Second quick tap toggles back to eraser
    pg.keyboard.down("Space")
    pg.wait_for_timeout(50)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_second_tap = pg.evaluate("window.state.activeTool")
    check("second quick-tap Space toggles back to previous tool (eraser)", tool_after_second_tap == "eraser", f"tool={tool_after_second_tap}")

    # 2. Hold Space (>=250ms) and pan canvas
    box = pg.locator("#wet").bounding_box()
    cx, cy = box["x"] + 300, box["y"] + 300
    init_pan_x = pg.evaluate("window.getViewport().panX")

    pg.keyboard.down("Space")
    pg.wait_for_timeout(100)
    pg.mouse.move(cx, cy)
    pg.mouse.down()
    pg.mouse.move(cx - 100, cy)
    pg.mouse.up()
    pg.wait_for_timeout(100)
    panned_pan_x = pg.evaluate("window.getViewport().panX")
    check("dragging during Space hold updates viewport pan coordinates", panned_pan_x != init_pan_x, f"init={init_pan_x} panned={panned_pan_x}")

    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_hold_pan = pg.evaluate("window.state.activeTool")
    check("releasing Space after pan reverts tool to eraser", tool_after_hold_pan == "eraser", f"tool={tool_after_hold_pan}")

    # 3. Left-click drag in Pan mode updates viewport pan
    pg.evaluate("window.toolManager.setTool('pan')")
    cur_pan_x = pg.evaluate("window.getViewport().panX")
    pg.mouse.move(cx, cy)
    pg.mouse.down()
    pg.mouse.move(cx + 80, cy)
    pg.mouse.up()
    pg.wait_for_timeout(50)
    moved_pan_x = pg.evaluate("window.getViewport().panX")
    check("left-click canvas drag in Pan mode updates viewport pan", moved_pan_x != cur_pan_x, f"cur={cur_pan_x} moved={moved_pan_x}")

    # -------------------------------------------------------------
    # T4: PDF Text Selection, Highlights & Clipboard
    # -------------------------------------------------------------
    print("\n=== T4  PDF Text Selection, Highlights & Clipboard ===", flush=True)
    pg.locator("#btnDockTextSelect").click(force=True)
    pg.wait_for_timeout(50)
    check("textSelect tool is active", pg.evaluate("window.state.activeTool === 'textSelect'"))

    # Preload page text data in state
    pg.evaluate("import('./js/workspace/text-selection.js').then(ts => ts.ensurePageTextData(0))")
    pg.wait_for_timeout(100)

    # Compute screen coordinates for text on page 0 and drag select
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
    check("canvas drag selection creates selection range and rects", has_sel and len(drag_text) > 0, f"text='{drag_text}'")

    pop_visible = pg.evaluate("!document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("selection popover appears with Copy button", pop_visible and pg.locator("#btnTextCopy").count() == 1)

    # Copy via Ctrl+C shortcut
    pg.keyboard.press("Control+c")
    pg.wait_for_timeout(100)
    copied = pg.evaluate("navigator.clipboard.readText()")
    check("Ctrl+C / clipboard copy copies selected text accurately", copied == drag_text and len(copied) > 0, f"copied='{copied}'")

    # Multi-line character indexing is respected across line breaks
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
    check("multi-line character indexing is respected across line breaks",
          "Hello InkWell" in sel_text and "Sec" in sel_text, f"selected='{sel_text}'")

    # Word expansion boundary checking (multi-line isolation)
    word_expand_res = pg.evaluate("""
    import('./js/workspace/text-selection.js').then(async ts => {
      await ts.ensurePageTextData(0);
      const w0 = ts.expandSelectionToWord(0, 0);
      const w1 = ts.expandSelectionToWord(0, 8);
      const w2 = ts.expandSelectionToWord(0, 14);
      return {
        w0: w0 ? w0.text : '',
        w1: w1 ? w1.text : '',
        w2: w2 ? w2.text : ''
      };
    })
    """)
    check("expandSelectionToWord isolates word boundaries without bleeding across lines",
          word_expand_res["w0"] == "Hello" and word_expand_res["w1"] == "InkWell" and word_expand_res["w2"] == "Second",
          f"w0='{word_expand_res.get('w0')}', w1='{word_expand_res.get('w1')}', w2='{word_expand_res.get('w2')}'")

    # T4.1: Escape key dismisses text selection and closes popover
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(50)
    esc_cleared = pg.evaluate("!window.state.textSelection && !window.state.selectedTextString && document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("Escape key dismisses text selection and closes popover", esc_cleared)

    # T4.2: Single click without drag does not leave a single-character selection trapped
    pg.mouse.move(screen_pt["x0"], screen_pt["y0"])
    pg.mouse.click(screen_pt["x0"], screen_pt["y0"])
    pg.wait_for_timeout(50)
    click_not_trapped = pg.evaluate("!window.state.textSelection && document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("single click deselects and does not leave trapped character selection", click_not_trapped)

    # T4.3: Switching tools away from textSelect clears selection and hides popover
    pg.mouse.move(screen_pt["x0"], screen_pt["y0"])
    pg.mouse.down()
    pg.mouse.move(screen_pt["x1"], screen_pt["y1"])
    pg.mouse.up()
    pg.wait_for_timeout(50)
    pg.locator("#btnDockPen").click()
    pg.wait_for_timeout(50)
    tool_switch_cleared = pg.evaluate("window.state.activeTool === 'pen' && !window.state.textSelection && document.getElementById('textSelectionPopover').classList.contains('hidden')")
    check("switching tool away from textSelect clears selection and hides popover", tool_switch_cleared)
    pg.locator("#btnDockTextSelect").click()
    pg.wait_for_timeout(50)

    # -------------------------------------------------------------
    # T5: Canvas Context Menu & Tool Triggering
    # -------------------------------------------------------------
    print("\n=== T5  Canvas Context Menu & Tool Triggering ===", flush=True)
    pg.locator("#wet").click(button="right", position={"x": 250, "y": 250})
    pg.wait_for_timeout(100)
    ctx_visible = pg.evaluate("!document.getElementById('canvasContextMenu').classList.contains('hidden')")
    ctx_items_ok = pg.evaluate("""
    !!(document.getElementById('ctxMenuCopy') &&
       document.getElementById('ctxMenuCut') &&
       document.getElementById('ctxMenuPaste') &&
       document.getElementById('ctxMenuDuplicate') &&
       document.getElementById('ctxMenuDelete'))
    """)
    check("right-click on canvas opens context menu with action items", ctx_visible and ctx_items_ok)

    # Click outside dismisses context menu
    pg.mouse.click(box["x"] + 10, box["y"] + 10)
    pg.wait_for_timeout(50)
    ctx_hidden = pg.evaluate("document.getElementById('canvasContextMenu').classList.contains('hidden')")
    check("clicking outside dismisses canvas context menu", ctx_hidden)

    # -------------------------------------------------------------
    # T6: Radial Tool Menu
    # -------------------------------------------------------------
    print("\n=== T6  Radial Tool Menu ===", flush=True)
    pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(300, 300))")
    pg.wait_for_timeout(50)
    radial_visible = pg.evaluate("!document.getElementById('radialMenu').classList.contains('hidden')")
    check("showRadialMenu displays radial menu overlay", radial_visible)

    radial_items_count = pg.locator(".radial-item").count()
    check("query selector .radial-item finds interactive radial slots", radial_items_count >= 4, f"count={radial_items_count}")

    eraser_item = pg.locator(".radial-item[data-tool='eraser']")
    eraser_item.click(force=True)
    pg.wait_for_timeout(50)
    active_after_radial = pg.evaluate("window.state.activeTool")
    radial_closed = pg.evaluate("document.getElementById('radialMenu').classList.contains('hidden')")
    check("clicking .radial-item switches tool accurately and closes menu",
          active_after_radial == "eraser" and radial_closed, f"tool={active_after_radial}")

    # -------------------------------------------------------------
    # T7: Command Palette
    # -------------------------------------------------------------
    print("\n=== T7  Command Palette ===", flush=True)
    pg.keyboard.press("Control+K")
    pg.wait_for_timeout(100)
    cmd_open = pg.evaluate("!document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    check("Ctrl+K opens command palette modal", cmd_open)

    pg.keyboard.press("ArrowDown")
    pg.wait_for_timeout(50)
    sel_idx_1 = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("ArrowDown navigates selection to next command item", sel_idx_1 == "1", f"index={sel_idx_1}")

    pg.keyboard.press("ArrowUp")
    pg.wait_for_timeout(50)
    sel_idx_0 = pg.evaluate("document.querySelector('.cmd-item.selected') ? document.querySelector('.cmd-item.selected').getAttribute('data-index') : null")
    check("ArrowUp navigates selection back to top command item", sel_idx_0 == "0", f"index={sel_idx_0}")

    pg.keyboard.press("Escape")
    pg.wait_for_timeout(50)
    cmd_closed = pg.evaluate("document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    check("Escape key dismisses command palette", cmd_closed)

    # -------------------------------------------------------------
    # T8: Touch Target & Accessibility Ergonomics (F13-F15)
    # -------------------------------------------------------------
    print("\n=== T8  Touch Target & Accessibility Ergonomics (F13-F15) ===", flush=True)
    # Compact button hit expansion verification
    compact_buttons = [
        ("#btnNavBack", ".header-icon-btn"),
        ("#btnNavForward", ".header-icon-btn"),
        ("#btnHeaderSave", ".header-icon-btn"),
        ("#btnHeaderPrevPage", ".nav-cluster-btn"),
        ("#btnZoomIn", ".zoom-dock-btn"),
        ("#btnNewTab", ".tab-add-btn"),
        ("#btnCloseDrawer", ".drawer-close-btn"),
    ]
    all_pseudo_ok = True
    for sel, cls in compact_buttons:
        info = pg.evaluate(f"""() => {{
            const el = document.querySelector('{sel}');
            if (!el) return null;
            const cs = window.getComputedStyle(el, '::before');
            return {{
                minWidth: cs.minWidth,
                minHeight: cs.minHeight,
                position: cs.position
            }};
        }}""")
        if not info or info['minWidth'] != '44px' or info['minHeight'] != '44px' or info['position'] != 'absolute':
            all_pseudo_ok = False
            check(f"{sel} has 44x44px pseudo hit area", False, f"info={info}")
    if all_pseudo_ok:
        check("compact buttons expand to >= 44x44px via ::before pseudo-elements", True)

    # Outer hit-test dispatch triggers click
    outer_hit_ok = pg.evaluate("""() => {
        const btn = document.querySelector('#btnHeaderSave');
        let clicked = false;
        const listener = () => { clicked = true; };
        btn.addEventListener('click', listener);
        const rect = btn.getBoundingClientRect();
        const tapX = rect.left + rect.width / 2;
        const tapY = rect.top - 3;
        const targetEl = document.elementFromPoint(tapX, tapY);
        const evt = new MouseEvent('click', { clientX: tapX, clientY: tapY, bubbles: true });
        if (targetEl) targetEl.dispatchEvent(evt);
        btn.removeEventListener('click', listener);
        return clicked;
    }""")
    check("hit-testing outer pseudo-element area triggers button click", outer_hit_ok)

    # Focus visible outline rules verification
    focus_visible_rule_exists = pg.evaluate("""() => {
        const rules = Array.from(document.styleSheets).flatMap(sheet => {
            try { return Array.from(sheet.cssRules); } catch (e) { return []; }
        });
        return rules.some(r =>
            r.selectorText &&
            r.selectorText.includes(':focus-visible') &&
            (r.style.outline.includes('7c3aed') || r.style.outline.includes('rgb(124, 58, 237)') ||
             r.style.outlineColor.includes('124, 58, 237') || r.style.outlineColor.includes('7c3aed'))
        );
    }""")
    check("universal :focus-visible high-contrast outline rules present in stylesheet", focus_visible_rule_exists)

    # Glassmorphic toast ARIA attributes
    toast_aria_ok = pg.evaluate("""() => {
        window.showToast('Test status notification', 'info');
        window.showToast('Test error notification', 'error');
        const tc = document.getElementById('toastContainer');
        const toasts = document.querySelectorAll('.toast');
        const infoToast = toasts[toasts.length - 2];
        const errorToast = toasts[toasts.length - 1];
        return {
            containerAria: tc ? tc.getAttribute('aria-live') === 'polite' : false,
            infoRole: infoToast ? infoToast.getAttribute('role') === 'status' : false,
            errorRole: errorToast ? errorToast.getAttribute('role') === 'alert' : false,
        };
    }""")
    check("glassmorphic toast notifications implement ARIA polite/status/alert roles",
          toast_aria_ok['containerAria'] and toast_aria_ok['infoRole'] and toast_aria_ok['errorRole'])

    # -------------------------------------------------------------
    # T9: Navigation Rail & Drawer Panels
    # -------------------------------------------------------------
    print("\n=== T9  Navigation Rail & Drawer Panels ===", flush=True)
    drawers = ['btnRailThumbnails', 'btnRailOutline', 'btnRailSearch', 'btnRailDocInfo']
    for d in drawers:
        btn = pg.locator(f"#{d}")
        check(f"rail button #{d} exists", btn.count() == 1)
        if btn.count() > 0:
            btn.click(force=True)
            pg.wait_for_timeout(60)
    check("drawers toggle cleanly without exceptions", not errors, str(errors[:2]))

    # Page Insertion Modal & Thumbnail Synchronization
    pg.locator("#btnRailThumbnails").click(force=True)
    pg.wait_for_timeout(60)
    initial_pages = pg.evaluate("window.state.pageInfos ? window.state.pageInfos.length : 0")
    initial_thumbs = pg.locator("#thumbnailGrid .thumb-card").count()
    check("initial thumbnail cards match page count", initial_thumbs == initial_pages,
          f"pages={initial_pages} thumbs={initial_thumbs}")

    pg.locator("#btnHeaderAddPage").click(force=True)
    pg.wait_for_timeout(60)
    check("insert page modal opens", pg.evaluate("!document.getElementById('insertPageModal').classList.contains('hidden')"))
    pg.locator("#btnConfirmInsertPage").click(force=True)
    pg.wait_for_timeout(300)

    updated_pages = pg.evaluate("window.state.pageInfos ? window.state.pageInfos.length : 0")
    updated_thumbs = pg.locator("#thumbnailGrid .thumb-card").count()
    insert_error = any("Failed to insert page" in t for t in pg.locator(".toast-error").all_text_contents())

    check("page insertion increments state.pageInfos length",
          updated_pages == initial_pages + 1,
          f"before={initial_pages} after={updated_pages}")
    check("thumbnailGrid contains updated card count without TypeError",
          updated_thumbs == updated_pages and not insert_error,
          f"thumbs={updated_thumbs} pages={updated_pages} insertError={insert_error}")
    check("page insertion runs with zero console errors", not errors, str(errors[:2]))

    # -------------------------------------------------------------
    # T10: Synthetic Pen Input Pipeline
    # -------------------------------------------------------------
    print("\n=== T10 Synthetic Pen Input Pipeline ===", flush=True)
    pg.locator("#btnDockPen").click(force=True)
    pg.wait_for_timeout(50)

    cdp = ctx.new_cdp_session(pg)
    box = pg.locator("#wet").bounding_box()
    ox, oy = box["x"] + 100, box["y"] + 200

    cdp.send("Input.dispatchMouseEvent", {
        "type": "mousePressed", "x": ox, "y": oy, "button": "left",
        "buttons": 1, "pointerType": "pen", "force": 0.2, "clickCount": 1
    })
    for i in range(30):
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseMoved", "x": ox + i * 8, "y": oy + 20 * math.sin(i / 5),
            "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.4 + 0.5 * (i / 30)
        })
    cdp.send("Input.dispatchMouseEvent", {
        "type": "mouseReleased", "x": ox + 240, "y": oy,
        "button": "left", "buttons": 0, "pointerType": "pen", "force": 0.1
    })
    pg.wait_for_timeout(300)

    stroke_count = pg.evaluate("window.state.strokes ? window.state.strokes.length : 0")
    check("pen stroke committed to document state", stroke_count >= 1, f"strokes={stroke_count}")

    dry_pixels = pg.evaluate("document.getElementById('dry').toDataURL().length > 500")
    check("dry canvas composited ink bitmap", dry_pixels)

    # -------------------------------------------------------------
    # T11: Zoom Controls & Percentage Readout
    # -------------------------------------------------------------
    print("\n=== T11 Zoom Controls & Percentage Readout ===", flush=True)
    btn_zoom_in = pg.locator("#btnZoomIn")
    btn_zoom_out = pg.locator("#btnZoomOut")
    check("zoom in and out buttons exist", btn_zoom_in.count() == 1 and btn_zoom_out.count() == 1)

    initial_zoom = pg.locator("#zoomLevelDisplay").text_content()
    pg.evaluate("document.getElementById('btnZoomIn').click()")
    pg.wait_for_timeout(100)
    zoom_in_text = pg.locator("#zoomLevelDisplay").text_content()
    check("zoom in updates zoom percentage readout", zoom_in_text != initial_zoom, f"initial={initial_zoom} zoomed={zoom_in_text}")

    pg.evaluate("document.getElementById('btnZoomOut').click()")
    pg.wait_for_timeout(100)
    zoom_out_text = pg.locator("#zoomLevelDisplay").text_content()
    check("zoom out restores zoom readout", zoom_out_text == initial_zoom, f"initial={initial_zoom} restored={zoom_out_text}")

    # Custom zoom input & popover dismissal
    pg.locator("#btnZoomMenu").click()
    pg.wait_for_timeout(50)
    check("zoom menu popover opens", pg.evaluate("!document.getElementById('zoomMenuPopover').classList.contains('hidden')"))

    pg.locator("#inputCustomZoom").fill("120")
    pg.locator("#btnApplyCustomZoom").click()
    pg.wait_for_timeout(100)

    custom_zoom_text = pg.locator("#zoomLevelDisplay").text_content()
    pop_closed = pg.evaluate("document.getElementById('zoomMenuPopover').classList.contains('hidden')")
    cur_zoom_val = pg.evaluate("window.getViewport().zoom")
    check("custom zoom applies 120% and closes zoom menu with zero errors",
          pop_closed and abs(cur_zoom_val - 1.2) < 0.05 and not errors,
          f"zoomText='{custom_zoom_text}', zoomVal={cur_zoom_val}, popClosed={pop_closed}")

    # Horizontal pan clamping on off-center focal zooms
    pan_clamping = pg.evaluate('''(() => {
        const vp = window.getViewport();
        // Zoom in with focal point far to the right (Step 3 verification)
        vp.setZoom(3.0, [2000, 500]);
        const panX1 = vp.panX;
        const clamped1 = vp.clampPanX(panX1, 'left');

        // Zoom out with focal point far to the left
        vp.setZoom(0.5, [-500, 0]);
        const panX2 = vp.panX;
        const clamped2 = vp.clampPanX(panX2, 'left');

        // Extreme off-center zoom with focal point far to the right
        vp.setZoom(4.0, [5000, 0]);
        const panX3 = vp.panX;
        const clamped3 = vp.clampPanX(panX3, 'left');

        // Restore viewport to normal view
        vp.fitPage(595, 842, 'left');

        return {
            zoomInOk: panX1 === clamped1,
            zoomOutOk: panX2 === clamped2,
            extremeOk: panX3 === clamped3,
            panX1, clamped1,
            panX2, clamped2,
            panX3, clamped3
        };
    })()''')
    check("horizontal pan remains bounded by clampPanX during off-center focal zooms",
          pan_clamping["zoomInOk"] and pan_clamping["zoomOutOk"] and pan_clamping["extremeOk"],
          f"results={pan_clamping}")

    # Touchpad pinch zoom test (WheelEvent with ctrlKey=true, deltaMode=0)
    pinch_res = pg.evaluate("""(() => {
        const vp = window.getViewport();
        const z0 = vp.zoom;
        // Two-finger pinch out (zoom in): deltaY is negative, deltaMode is 0 (pixel)
        window.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: 600,
            clientY: 400,
            deltaY: -20,
            deltaMode: 0,
            ctrlKey: true
        }));
        const zIn = vp.zoom;
        // Two-finger pinch in (zoom out): deltaY is positive, deltaMode is 0 (pixel)
        window.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: 600,
            clientY: 400,
            deltaY: 20,
            deltaMode: 0,
            ctrlKey: true
        }));
        const zOut = vp.zoom;
        return { z0, zIn, zOut, inGain: zIn / z0, outRatio: zOut / zIn };
    })()""")
    check("touchpad pinch zoom scales smoothly and reversibly",
          pinch_res["zIn"] > pinch_res["z0"] and 1.15 <= pinch_res["inGain"] <= 1.50 and abs(pinch_res["zOut"] - pinch_res["z0"]) < 0.05,
          f"z0={pinch_res['z0']:.3f}, zIn={pinch_res['zIn']:.3f}, zOut={pinch_res['zOut']:.3f}, gain={pinch_res['inGain']:.2f}")

    # -------------------------------------------------------------
    # T12: WAL Undo/Redo IPC Synchronization
    # -------------------------------------------------------------
    print("\n=== T12 WAL Undo/Redo IPC Synchronization ===", flush=True)

    # 1. Text Object Undo / Redo
    pg.evaluate("""(() => {
        window.__walTextMutations = [];
        window.documentOps.addTextObject({
            id: 'txt_test_wal_1',
            sheet: 0,
            x: 120,
            y: 150,
            text: 'WAL undo/redo test note'
        });
    })()""")
    pg.wait_for_timeout(60)

    # Undo text addition -> expect journal_text_mutation op: 'delete'
    pg.evaluate("window.documentOps.performUndo()")
    pg.wait_for_timeout(60)

    last_text_undo = pg.evaluate("""(() => {
        const list = window.__walTextMutations || [];
        return list.length > 0 ? list[list.length - 1] : null;
    })()""")
    check("text undo journals delete mutation to WAL IPC",
          last_text_undo and last_text_undo.get("op") == "delete" and last_text_undo.get("textId") == "txt_test_wal_1",
          f"last_text_undo={last_text_undo}")

    # Redo text addition -> expect journal_text_mutation op: 'upsert'
    pg.evaluate("window.documentOps.performRedo()")
    pg.wait_for_timeout(60)

    last_text_redo = pg.evaluate("""(() => {
        const list = window.__walTextMutations || [];
        return list.length > 0 ? list[list.length - 1] : null;
    })()""")
    check("text redo journals upsert mutation to WAL IPC",
          last_text_redo and last_text_redo.get("op") == "upsert" and last_text_redo.get("text", {}).get("id") == "txt_test_wal_1",
          f"last_text_redo={last_text_redo}")

    # 2. Image Object Undo / Redo
    pg.evaluate("""(() => {
        window.__walImageMutations = [];
        window.documentOps.addImage({
            id: 'img_test_wal_1',
            sheet: 0,
            x: 200,
            y: 200,
            width: 100,
            height: 80,
            dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        });
    })()""")
    pg.wait_for_timeout(60)

    # Undo image addition -> expect journal_image_mutation op: 'delete'
    pg.evaluate("window.documentOps.performUndo()")
    pg.wait_for_timeout(60)

    last_image_undo = pg.evaluate("""(() => {
        const list = window.__walImageMutations || [];
        return list.length > 0 ? list[list.length - 1] : null;
    })()""")
    check("image undo journals delete mutation to WAL IPC",
          last_image_undo and last_image_undo.get("op") == "delete" and last_image_undo.get("imageId") == "img_test_wal_1",
          f"last_image_undo={last_image_undo}")

    # Redo image addition -> expect journal_image_mutation op: 'upsert'
    pg.evaluate("window.documentOps.performRedo()")
    pg.wait_for_timeout(60)

    last_image_redo = pg.evaluate("""(() => {
        const list = window.__walImageMutations || [];
        return list.length > 0 ? list[list.length - 1] : null;
    })()""")
    check("image redo journals upsert mutation to WAL IPC",
          last_image_redo and last_image_redo.get("op") == "upsert" and last_image_redo.get("image", {}).get("id") == "img_test_wal_1",
          f"last_image_redo={last_image_redo}")

    # 3. Batch Delete Objects Undo / Redo
    pg.evaluate("""(() => {
        window.__walImageMutations = [];
        window.__walTextMutations = [];
        window.documentOps.deleteObjectsBatch({
            strokes: [],
            images: [{ id: 'img_batch_1', sheet: 0, x: 50, y: 50, width: 40, height: 40 }],
            textObjects: [{ id: 'txt_batch_1', sheet: 0, x: 60, y: 60, text: 'batch item' }]
        });
    })()""")
    pg.wait_for_timeout(60)

    # Undo batch delete -> expect upsert for image and text
    pg.evaluate("window.documentOps.performUndo()")
    pg.wait_for_timeout(60)

    batch_undo_img = pg.evaluate("window.__walImageMutations ? window.__walImageMutations.slice(-1)[0] : null")
    batch_undo_txt = pg.evaluate("window.__walTextMutations ? window.__walTextMutations.slice(-1)[0] : null")
    check("batch deletion undo journals upsert mutations to WAL IPC",
          batch_undo_img and batch_undo_img.get("op") == "upsert" and
          batch_undo_txt and batch_undo_txt.get("op") == "upsert",
          f"img={batch_undo_img} txt={batch_undo_txt}")

    # Redo batch delete -> expect delete for image and text
    pg.evaluate("window.documentOps.performRedo()")
    pg.wait_for_timeout(60)

    batch_redo_img = pg.evaluate("window.__walImageMutations ? window.__walImageMutations.slice(-1)[0] : null")
    batch_redo_txt = pg.evaluate("window.__walTextMutations ? window.__walTextMutations.slice(-1)[0] : null")
    check("batch deletion redo journals delete mutations to WAL IPC",
          batch_redo_img and batch_redo_img.get("op") == "delete" and batch_redo_img.get("imageId") == "img_batch_1" and
          batch_redo_txt and batch_redo_txt.get("op") == "delete" and batch_redo_txt.get("textId") == "txt_batch_1",
          f"img={batch_redo_img} txt={batch_redo_txt}")

    # 4. Transform Objects Undo / Redo
    pg.evaluate("""(() => {
        window.__walImageMutations = [];
        window.__walTextMutations = [];
        window.documentOps.commitTransform({
            initialStrokes: [],
            initialImages: [{ id: 'img_tr_1', x: 10, y: 10, width: 50, height: 50 }],
            initialTextObjects: [{ id: 'txt_tr_1', x: 20, y: 20, fontSize: 16 }],
            finalStrokes: [],
            finalImages: [{ id: 'img_tr_1', x: 100, y: 100, width: 80, height: 80 }],
            finalTextObjects: [{ id: 'txt_tr_1', x: 120, y: 120, fontSize: 20 }]
        });
    })()""")
    pg.wait_for_timeout(60)

    # Undo transform -> expect initial values upserted
    pg.evaluate("window.documentOps.performUndo()")
    pg.wait_for_timeout(60)

    tr_undo_img = pg.evaluate("window.__walImageMutations ? window.__walImageMutations.slice(-1)[0] : null")
    tr_undo_txt = pg.evaluate("window.__walTextMutations ? window.__walTextMutations.slice(-1)[0] : null")
    check("transform undo journals initial state upserts to WAL IPC",
          tr_undo_img and tr_undo_img.get("op") == "upsert" and tr_undo_img.get("image", {}).get("x") == 10 and
          tr_undo_txt and tr_undo_txt.get("op") == "upsert" and tr_undo_txt.get("text", {}).get("x") == 20,
          f"img={tr_undo_img} txt={tr_undo_txt}")

    # Redo transform -> expect final values upserted
    pg.evaluate("window.documentOps.performRedo()")
    pg.wait_for_timeout(60)

    tr_redo_img = pg.evaluate("window.__walImageMutations ? window.__walImageMutations.slice(-1)[0] : null")
    tr_redo_txt = pg.evaluate("window.__walTextMutations ? window.__walTextMutations.slice(-1)[0] : null")
    check("transform redo journals final state upserts to WAL IPC",
          tr_redo_img and tr_redo_img.get("op") == "upsert" and tr_redo_img.get("image", {}).get("x") == 100 and
          tr_redo_txt and tr_redo_txt.get("op") == "upsert" and tr_redo_txt.get("text", {}).get("x") == 120,
          f"img={tr_redo_img} txt={tr_redo_txt}")

    # -------------------------------------------------------------
    # T13: Document Text Layer Isolation & Page Shift Cache
    # -------------------------------------------------------------
    print("\n=== T13 Document Text Layer Isolation & Page Shift Cache ===", flush=True)
    # 1. Page text cache shifting on page insertion
    pg.evaluate("""(() => {
        window.state.pageTextData = {
            0: { page_index: 0, text: 'Page 0 text' },
            1: { page_index: 1, text: 'Page 1 text' }
        };
        window.state.pageTextSpans = {
            0: [{ text: 'Page 0 span', rect: [0, 0, 10, 10], page_index: 0 }],
            1: [{ text: 'Page 1 span', rect: [0, 0, 10, 10], page_index: 1 }]
        };
        window.documentOps.insertPageAtIndex(0, { page_index: 0, width_pt: 612, height_pt: 792 });
    })()""")
    pg.wait_for_timeout(60)

    shift_ok = pg.evaluate("""(() => {
        const d0 = window.state.pageTextData[0];
        const d1 = window.state.pageTextData[1];
        const d2 = window.state.pageTextData[2];
        const s0 = window.state.pageTextSpans[0];
        const s1 = window.state.pageTextSpans[1];
        const s2 = window.state.pageTextSpans[2];
        return d0 === undefined && d1?.text === 'Page 0 text' && d2?.text === 'Page 1 text' &&
               s0 === undefined && s1?.[0]?.text === 'Page 0 span' && s2?.[0]?.text === 'Page 1 span';
    })()""")
    check("inserting a page at index 0 shifts pageTextData and pageTextSpans", shift_ok)

    # 2. Text layer, selection, and search isolation on setDocument
    pg.evaluate("""(() => {
        window.state.pageTextData = { 0: { page_index: 0, text: 'Old doc text' } };
        window.state.pageTextSpans = { 0: [{ text: 'Old doc span' }] };
        window.state.pageTextLoading = { 0: Promise.resolve() };
        window.state.selectedTextSpans = [{ text: 'Old span' }];
        window.state.selectedTextString = 'Old span';
        window.state.textSelection = { sheet: 0, startCharIdx: 0, endCharIdx: 8, text: 'Old span' };
        window.state.textSelectAnchor = { sheet: 0, charIndex: 0 };
        window.state.textSelectPending = { sheet: 0 };
        window.state.isSelectingText = true;
        window.state.searchQuery = 'search term';
        window.state.searchResults = [{ sheet: 0, rects: [] }];
        window.state.activeSearchMatch = 1;
        window.state.isSearching = true;

        window.documentOps.setDocument({
            pageInfos: [{ page_index: 0, width_pt: 612, height_pt: 792 }],
            strokes: []
        });
    })()""")
    pg.wait_for_timeout(60)

    doc_reset_res = pg.evaluate("""(() => {
        return {
            textDataEmpty: Object.keys(window.state.pageTextData || {}).length === 0,
            textSpansEmpty: Object.keys(window.state.pageTextSpans || {}).length === 0,
            textLoadingEmpty: Object.keys(window.state.pageTextLoading || {}).length === 0,
            selSpansEmpty: (window.state.selectedTextSpans || []).length === 0,
            selStringEmpty: window.state.selectedTextString === '',
            textSelNull: window.state.textSelection === null,
            textAnchorNull: window.state.textSelectAnchor === null,
            textPendingNull: window.state.textSelectPending === null,
            isSelectingFalse: window.state.isSelectingText === false,
            searchQueryEmpty: window.state.searchQuery === '',
            searchResultsEmpty: (window.state.searchResults || []).length === 0,
            activeSearchZero: window.state.activeSearchMatch === 0,
            isSearchingFalse: window.state.isSearching === false,
        };
    })()""")
    check("setDocument clears pageTextData and pageTextSpans cache",
          doc_reset_res["textDataEmpty"] and doc_reset_res["textSpansEmpty"] and doc_reset_res["textLoadingEmpty"],
          f"data={doc_reset_res}")
    check("setDocument clears textSelection and selection state",
          doc_reset_res["textSelNull"] and doc_reset_res["selStringEmpty"] and doc_reset_res["selSpansEmpty"] and doc_reset_res["isSelectingFalse"])
    check("setDocument clears searchResults and search query",
          doc_reset_res["searchResultsEmpty"] and doc_reset_res["searchQueryEmpty"] and doc_reset_res["isSearchingFalse"] and doc_reset_res["activeSearchZero"])

    # -------------------------------------------------------------
    # T14: Console Hygiene
    # -------------------------------------------------------------
    print("\n=== T14 Console Hygiene ===", flush=True)
    check("zero console errors throughout session", not errors, str(errors[:3]))
    inkwell_warnings = [w for w in warnings if "[inkwell/" in w]
    check("zero internal inkwell warnings", not inkwell_warnings, str(inkwell_warnings[:3]))

    b.close()

print(f"\n{'='*62}\n  {sum(results)}/{len(results)} checks passed\n{'='*62}", flush=True)
sys.exit(0 if all(results) else 1)
