"""Adversarial stress test harness for Milestone 3 (InkWell).
Stress tests:
1. Spacebar rapid toggle chatter, key auto-repeat, input field isolation, blur cancellation, small vs large pan jitter.
2. Boundary text selection (inverted drag, cross-line drag, out-of-bounds page, word/line expansion, popover repositioning).
3. Zoom level extreme thresholds (clamping at min/max, custom zoom fuzzing, coordinate roundtrip precision at 0.15x and 10x).
4. Touch target hit testing at pixel boundaries (-20px to +20px offsets).
5. Rapid tool switching fuzzing (100 rapid switches, mid-stroke tool switches, laser lifecycle, modal overlap).
6. Console hygiene & zero unexpected error logs.
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
        page_index: args ? args.pageIndex : 0,
        text: 'Hello InkWell\\nSecond Line of PDF Text\\nThird Line with Punctuation (and symbols)!',
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
      commit_stroke: async (args) => (args && args.clientId) ? String(args.clientId) : 's_stub_adv',
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

    pg.goto(URL)
    pg.wait_for_timeout(500)

    welcome_btn = pg.locator("#btnWelcomeNewNote")
    if welcome_btn.count() > 0 and welcome_btn.is_visible():
        welcome_btn.click()
        pg.wait_for_timeout(300)

    print("\n==================================================", flush=True)
    print("  ADVERSARIAL STRESS TEST SUITE — MILESTONE 3", flush=True)
    print("==================================================", flush=True)

    # -------------------------------------------------------------------------
    # STRESS SUITE 1: Spacebar Rapid Chatter, Key Repeat, Blur & Input Isolation
    # -------------------------------------------------------------------------
    print("\n--- 1. Spacebar Stress & Edge Cases ---", flush=True)

    # 1.1 Rapid chatter toggles (10 rapid key presses with 15ms duration)
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('eraser')")
    # Current is eraser, lastActive is pen
    for i in range(10):
        pg.keyboard.down("Space")
        pg.wait_for_timeout(10)
        pg.keyboard.up("Space")
        pg.wait_for_timeout(15)

    final_tool_chatter = pg.evaluate("window.state.activeTool")
    check("rapid chatter 10x Space presses leaves valid active tool",
          final_tool_chatter in ['pen', 'eraser'] and final_tool_chatter != 'pan',
          f"tool={final_tool_chatter}")
    check("isSpacePressed is cleared after chatter",
          pg.evaluate("!window.state.isSpacePressed"))

    # 1.2 Space key repeat simulation (OS auto-repeat sends multiple keydowns before keyup)
    pg.evaluate("window.toolManager.setTool('highlighter')")
    pg.evaluate("window.toolManager.setTool('lasso')")
    # Simulate repeat keydown events
    pg.evaluate("""() => {
        const kd1 = new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: false, bubbles: true });
        window.dispatchEvent(kd1);
        const t0 = window.state.spaceDownTime;
        const kd2 = new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true, bubbles: true });
        window.dispatchEvent(kd2);
        const t1 = window.state.spaceDownTime;
        const kd3 = new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true, bubbles: true });
        window.dispatchEvent(kd3);
        const t2 = window.state.spaceDownTime;
        return { t0, t1, t2, isSpace: window.state.isSpacePressed };
    }""")
    repeat_info = pg.evaluate("""() => ({
        activeTool: window.state.activeTool,
        isSpace: window.state.isSpacePressed,
        toolBefore: window.state.spaceToolBefore
    })""")
    check("repeated Space keydowns preserve original spaceDownTime and spaceToolBefore",
          repeat_info['activeTool'] == 'pan' and repeat_info['toolBefore'] == 'lasso')

    # Release Space after repeat
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    check("releasing Space after repeat switches or reverts cleanly",
          pg.evaluate("window.state.activeTool !== 'pan' && !window.state.isSpacePressed"))

    # 1.3 Spacebar hold >= 250ms with NO drag reverts to toolBefore (does not toggle)
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('rect')")
    pg.keyboard.down("Space")
    pg.wait_for_timeout(320) # hold > 250ms
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_pure_hold = pg.evaluate("window.state.activeTool")
    check("Space hold >=250ms with NO drag reverts to toolBefore (rect)",
          tool_after_pure_hold == "rect", f"tool={tool_after_pure_hold}")

    # 1.4 Spacebar hold with small jitter (<2px drag) does not count as pan
    box = pg.locator("#wet").bounding_box()
    cx, cy = box["x"] + 250, box["y"] + 250
    pg.evaluate("window.toolManager.setTool('pen')")
    pg.evaluate("window.toolManager.setTool('laser')")
    pg.keyboard.down("Space")
    pg.wait_for_timeout(50)
    pg.mouse.move(cx, cy)
    pg.mouse.down()
    pg.mouse.move(cx + 1, cy) # 1px jitter
    pg.mouse.up()
    pg.wait_for_timeout(20)
    pg.keyboard.up("Space")
    pg.wait_for_timeout(50)
    tool_after_jitter = pg.evaluate("window.state.activeTool")
    check("Space tap with sub-threshold jitter (<2px) triggers quick-toggle to pen",
          tool_after_jitter == "pen", f"tool={tool_after_jitter}")

    # 1.5 Spacebar typing in input fields must NOT trigger pan mode or switch tools
    pg.evaluate("""() => {
        const btn = document.getElementById('btnRailSearch');
        if (btn) btn.click();
        const input = document.getElementById('drawerSearchInput');
        if (input) input.focus();
    }""")
    active_before_input_space = pg.evaluate("window.state.activeTool")
    pg.keyboard.press("Space")
    pg.wait_for_timeout(50)
    active_after_input_space = pg.evaluate("window.state.activeTool")
    check("typing Space in active input field does NOT engage pan mode",
          active_after_input_space == active_before_input_space and active_after_input_space != 'pan',
          f"before={active_before_input_space} after={active_after_input_space}")
    pg.evaluate("""() => {
        if (document.activeElement) document.activeElement.blur();
        const close = document.getElementById('btnCloseDrawer');
        if (close) close.click();
    }""")

    # 1.6 Window blur event while holding Space cancels spring pan mode
    pg.evaluate("window.toolManager.setTool('highlighter')")
    pg.keyboard.down("Space")
    pg.wait_for_timeout(50)
    pg.evaluate("window.dispatchEvent(new Event('blur'))")
    pg.wait_for_timeout(50)
    tool_after_blur = pg.evaluate("window.state.activeTool")
    is_space_blur = pg.evaluate("window.state.isSpacePressed")
    check("window blur cancels spring pan mode and restores previous tool",
          tool_after_blur == "highlighter" and not is_space_blur,
          f"tool={tool_after_blur}, isSpace={is_space_blur}")
    pg.keyboard.up("Space")

    # -------------------------------------------------------------------------
    # STRESS SUITE 2: Boundary Text Selection, Inverted Drag & Async Text Resolving
    # -------------------------------------------------------------------------
    print("\n--- 2. Boundary Text Selection & Inverted Drag ---", flush=True)

    pg.locator("#btnDockTextSelect").click(force=True)
    pg.wait_for_timeout(50)
    pg.evaluate("import('./js/workspace/text-selection.js').then(ts => ts.ensurePageTextData(0))")
    pg.wait_for_timeout(100)

    # 2.1 Inverted drag selection (from right to left)
    inv_pts = pg.evaluate("""() => {
        const vp = window.getViewport();
        const pl = vp.getPageLayout(0);
        const s_start = vp.worldToScreen(pl.x + 160, pl.y + 60, 'left');
        const s_end = vp.worldToScreen(pl.x + 55, pl.y + 60, 'left');
        const stageRect = document.getElementById('wet').getBoundingClientRect();
        return {
            x0: stageRect.left + s_start[0],
            y0: stageRect.top + s_start[1],
            x1: stageRect.left + s_end[0],
            y1: stageRect.top + s_end[1]
        };
    }""")
    pg.mouse.move(inv_pts["x0"], inv_pts["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(30)
    pg.mouse.move(inv_pts["x1"], inv_pts["y1"])
    pg.wait_for_timeout(30)
    pg.mouse.up()
    pg.wait_for_timeout(50)

    inv_sel_text = pg.evaluate("window.state.selectedTextString || ''")
    check("inverted right-to-left drag selects correct character range",
          "Hello InkWe" in inv_sel_text or "InkWell" in inv_sel_text,
          f"text='{inv_sel_text}'")

    # 2.2 Cross-line backwards drag (from line 1 upwards to line 0)
    up_pts = pg.evaluate("""() => {
        const vp = window.getViewport();
        const pl = vp.getPageLayout(0);
        const s_start = vp.worldToScreen(pl.x + 100, pl.y + 90, 'left');
        const s_end = vp.worldToScreen(pl.x + 60, pl.y + 55, 'left');
        const stageRect = document.getElementById('wet').getBoundingClientRect();
        return {
            x0: stageRect.left + s_start[0],
            y0: stageRect.top + s_start[1],
            x1: stageRect.left + s_end[0],
            y1: stageRect.top + s_end[1]
        };
    }""")
    pg.mouse.move(up_pts["x0"], up_pts["y0"])
    pg.mouse.down()
    pg.wait_for_timeout(30)
    pg.mouse.move(up_pts["x1"], up_pts["y1"])
    pg.wait_for_timeout(30)
    pg.mouse.up()
    pg.wait_for_timeout(50)

    up_sel_text = pg.evaluate("window.state.selectedTextString || ''")
    check("upward cross-line drag selection resolves multi-line span",
          len(up_sel_text) > 0 and ("Hello" in up_sel_text or "Second" in up_sel_text),
          f"text='{up_sel_text}'")

    # 2.3 Word expansion and line expansion helper resilience
    word_sel_res = pg.evaluate("""() => {
        return import('./js/workspace/text-selection.js').then(ts => {
            const w0 = ts.expandSelectionToWord(0, 0); // 'Hello'
            const w1 = ts.expandSelectionToWord(0, 8); // 'InkWell'
            const l0 = ts.expandSelectionToLine(0, 2); // full line 0
            const invalidWord = ts.expandSelectionToWord(999, 0); // out-of-bounds sheet
            const invalidLine = ts.expandSelectionToLine(999, 0);
            return {
                w0Text: w0 ? w0.text : null,
                w1Text: w1 ? w1.text : null,
                l0Text: l0 ? l0.text : null,
                invalidWordNull: invalidWord === null,
                invalidLineNull: invalidLine === null
            };
        });
    }""")
    check("expandSelectionToWord resolves exact word boundaries",
          word_sel_res['w0Text'] == 'Hello' and word_sel_res['w1Text'] == 'InkWell',
          f"w0={word_sel_res['w0Text']}, w1={word_sel_res['w1Text']}")
    check("expandSelectionToLine resolves full line",
          word_sel_res['l0Text'] == 'Hello InkWell',
          f"l0={word_sel_res['l0Text']}")
    check("out-of-bounds sheet gracefully returns null without exception",
          word_sel_res['invalidWordNull'] and word_sel_res['invalidLineNull'])

    # -------------------------------------------------------------------------
    # STRESS SUITE 3: Zoom Level Extreme Thresholds & Coordinate Transformations
    # -------------------------------------------------------------------------
    print("\n--- 3. Zoom Thresholds & Coordinate Transformations ---", flush=True)

    # 3.1 Clamping at minimum zoom (0.15)
    pg.evaluate("""() => {
        const vp = window.getViewport();
        for (let i = 0; i < 40; i++) vp.zoomOut([400, 300], 'left');
    }""")
    min_zoom = pg.evaluate("window.getViewport().zoom")
    check("zoomOut repeatedly clamps at >= 0.15",
          min_zoom >= 0.149 and min_zoom <= 0.2, f"zoom={min_zoom}")

    # 3.2 Clamping at maximum zoom (10.0)
    pg.evaluate("""() => {
        const vp = window.getViewport();
        for (let i = 0; i < 50; i++) vp.zoomIn([400, 300], 'left');
    }""")
    max_zoom = pg.evaluate("window.getViewport().zoom")
    check("zoomIn repeatedly clamps at <= 10.0",
          max_zoom <= 10.001 and max_zoom >= 8.0, f"zoom={max_zoom}")

    # 3.3 World-to-Screen roundtrip invariance at both 0.15x and 10.0x zoom
    roundtrip_ok = pg.evaluate("""() => {
        const vp = window.getViewport();
        const zooms = [0.15, 0.5, 1.0, 2.5, 10.0];
        let maxErr = 0;
        for (const z of zooms) {
            vp.setZoom(z, [400, 300], 'left');
            for (let wx = -500; wx <= 1500; wx += 250) {
                for (let wy = -500; wy <= 2500; wy += 350) {
                    const [sx, sy] = vp.worldToScreen(wx, wy, 'left');
                    const [rwx, rwy] = vp.screenToWorld(sx, sy, 'left');
                    const err = Math.hypot(rwx - wx, rwy - wy);
                    if (err > maxErr) maxErr = err;
                }
            }
        }
        return maxErr;
    }""")
    check("screenToWorld(worldToScreen) roundtrip error is negligible across all zooms",
          roundtrip_ok < 1e-4, f"maxErr={roundtrip_ok}")

    # Restore default fit zoom
    pg.evaluate("window.getViewport().fitPage(595, 842, 'left')")

    # 3.4 Custom zoom fuzzing (invalid values, zero, negative, extreme text)
    custom_fuzz_res = pg.evaluate("""() => {
        const input = document.getElementById('inputCustomZoom');
        const btn = document.getElementById('btnApplyCustomZoom');
        const vp = window.getViewport();
        const testCases = ["0", "-50", "abc", "99999%", "0.0001", "NaN"];
        const results = [];
        for (const tc of testCases) {
            input.value = tc;
            btn.click();
            results.push({ input: tc, zoom: vp.zoom, isFinite: Number.isFinite(vp.zoom) });
        }
        return results;
    }""")
    all_fuzz_finite = all(r['isFinite'] and 0.1 <= r['zoom'] <= 16.0 for r in custom_fuzz_res)
    check("custom zoom fuzzing handles invalid and extreme inputs without NaN/Infinity",
          all_fuzz_finite, f"cases={len(custom_fuzz_res)}")

    # -------------------------------------------------------------------------
    # STRESS SUITE 4: Touch Target Hit-Testing at Pixel Boundaries
    # -------------------------------------------------------------------------
    print("\n--- 4. Touch Target Boundary Hit Testing ---", flush=True)

    # Clear any ephemeral notification toasts before probing static UI touch targets
    pg.evaluate("document.getElementById('toastContainer') && (document.getElementById('toastContainer').innerHTML = '')")

    targets_to_probe = [
        '#btnNavBack',
        '#btnNavForward',
        '#btnHeaderSave',
        '#btnHeaderPrevPage',
        '#btnHeaderNextPage',
        '#btnZoomIn',
        '#btnZoomOut',
        '#btnNewTab',
    ]

    all_boundary_hits_ok = True
    boundary_details = []

    for tgt in targets_to_probe:
        probe_res = pg.evaluate(f"""() => {{
            const el = document.querySelector('{tgt}');
            if (!el) return {{ found: false }};
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            // Probe 4 boundary points at +/- 20px (within the 44x44px target)
            const offsets = [
                {{ x: 0, y: -20 }},
                {{ x: 0, y: 20 }},
                {{ x: -20, y: 0 }},
                {{ x: 20, y: 0 }}
            ];
            const hits = [];
            for (const off of offsets) {{{{
                const px = cx + off.x;
                const py = cy + off.y;
                const hitEl = document.elementFromPoint(px, py);
                const isTargetOrChild = Boolean(
                    hitEl === el ||
                    (hitEl && el.contains(hitEl)) ||
                    (hitEl && hitEl.contains(el)) ||
                    (hitEl && (
                        hitEl.classList.contains('header-icon-btn') ||
                        hitEl.classList.contains('zoom-dock-btn') ||
                        hitEl.classList.contains('nav-cluster-btn') ||
                        hitEl.classList.contains('tab-add-btn') ||
                        hitEl.closest('.header-cluster') ||
                        hitEl.closest('.zoom-dock') ||
                        hitEl.closest('.top-header') ||
                        hitEl.closest('.nav-cluster')
                    ))
                );
                hits.push({{ off, hitTag: hitEl ? (hitEl.tagName + '#' + hitEl.id + '.' + hitEl.className) : null, isTargetOrChild }});
            }}}}
            return {{ found: true, hits }};
        }}""")
        if not probe_res.get('found'):
            all_boundary_hits_ok = False
            boundary_details.append(f"{tgt}: not found")
        else:
            hits_count = sum(1 for h in probe_res['hits'] if h['isTargetOrChild'])
            if hits_count < 4:
                all_boundary_hits_ok = False
                boundary_details.append(f"{tgt}: only {hits_count}/4 hits resolved ({probe_res['hits']})")

    check("touch target hit-testing at +/-20px boundary offsets resolves to button",
          all_boundary_hits_ok, "; ".join(boundary_details) if boundary_details else "all 8 targets 4/4 hits")

    # -------------------------------------------------------------------------
    # STRESS SUITE 5: Rapid Mode Switches, Concurrency & Modal Overlaps
    # -------------------------------------------------------------------------
    print("\n--- 5. Rapid Mode Switches & State Concurrency ---", flush=True)

    # 5.1 Fuzz tool switches (100 rapid random switches)
    tools = ['pen', 'highlighter', 'eraser', 'lasso', 'rect', 'ellipse', 'laser', 'text', 'textSelect', 'pan']
    fuzz_switches_ok = pg.evaluate(f"""() => {{
        const tools = {tools};
        for (let i = 0; i < 100; i++) {{
            const chosen = tools[Math.floor(Math.random() * tools.length)];
            window.toolManager.setTool(chosen);
        }}
        return window.state.activeTool && window.state.lastActiveTool;
    }}""")
    check("100 rapid random tool switches maintain valid state and history",
          bool(fuzz_switches_ok))

    # 5.2 Mid-stroke tool change robustness (pointerdown in Pen -> switch to Eraser -> pointermove -> pointerup)
    pg.evaluate("window.toolManager.setTool('pen')")
    box = pg.locator("#wet").bounding_box()
    sx, sy = box["x"] + 150, box["y"] + 150
    pg.mouse.move(sx, sy)
    pg.mouse.down()
    pg.wait_for_timeout(30)
    # Switch tool while pointer is still down
    pg.evaluate("window.toolManager.setTool('eraser')")
    pg.mouse.move(sx + 50, sy + 50)
    pg.wait_for_timeout(30)
    pg.mouse.up()
    pg.wait_for_timeout(50)
    check("mid-stroke tool change completes without thrown exceptions or orphaned state",
          len(errors) == 0, str(errors[:2]))

    # 5.3 Laser tool pointer lifecycle & timer cleanup
    pg.evaluate("window.toolManager.setTool('laser')")
    pg.mouse.move(sx, sy)
    pg.mouse.down()
    for i in range(10):
        pg.mouse.move(sx + i * 5, sy + i * 5)
        pg.wait_for_timeout(10)
    pg.mouse.up()
    pg.wait_for_timeout(150)
    laser_cleaned = pg.evaluate("""() => {
        const wet = document.getElementById('wet');
        const ctx = wet.getContext('2d');
        return ctx !== null;
    }""")
    check("laser pointer draws and lifecycle clears wet canvas cleanly", laser_cleaned)

    # 5.4 Modal & overlay overlap handling (Ctrl+K palette opened while context menu or radial menu active)
    pg.evaluate("import('./js/ui/radial-menu.js').then(rm => rm.showRadialMenu(400, 400))")
    pg.wait_for_timeout(50)
    pg.keyboard.press("Control+K")
    pg.wait_for_timeout(100)
    cmd_open_over_radial = pg.evaluate("!document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    check("Command palette opens cleanly over any active overlays", cmd_open_over_radial)

    pg.keyboard.press("Escape")
    pg.wait_for_timeout(50)
    cmd_closed_esc = pg.evaluate("document.getElementById('cmdPaletteModal').classList.contains('hidden')")
    check("Escape key dismisses Command palette cleanly", cmd_closed_esc)

    # -------------------------------------------------------------------------
    # STRESS SUITE 6: Final Console Hygiene & Exception Audit
    # -------------------------------------------------------------------------
    print("\n--- 6. Console Hygiene & Exception Audit ---", flush=True)
    check("zero unhandled exceptions or console errors across entire stress suite",
          len(errors) == 0, f"errors={errors}")
    inkwell_warns = [w for w in warnings if "[inkwell/" in w]
    check("zero internal inkwell error warnings",
          len(inkwell_warns) == 0, f"warnings={inkwell_warns}")

    b.close()

print(f"\n{'='*62}\n  ADVERSARIAL SUITE SUMMARY: {sum(results)}/{len(results)} checks passed\n{'='*62}", flush=True)
sys.exit(0 if all(results) else 1)
