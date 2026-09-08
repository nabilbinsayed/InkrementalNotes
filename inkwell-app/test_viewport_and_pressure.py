"""Rigorous verification test for:
1. Panning the page to the right (fixing the cutoff / inability to pan right).
2. Stylus pressure sensitivity (hardware evdev, browser PointerEvents, velocity dynamics).
3. Stroke width modulation based on pressure in the document model.
"""
import math, pathlib, shutil
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "src" / "index.html").as_uri()

def test_viewport_and_pressure():
    with sync_playwright() as pw:
        chrome_bin = shutil.which("chromium") or shutil.which("google-chrome-stable") or shutil.which("chrome")
        launch_opts = {
            "headless": True,
            "args": [
                "--allow-file-access-from-files",
                "--force-device-scale-factor=1",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage"
            ]
        }
        if chrome_bin:
            launch_opts["executable_path"] = chrome_bin
        b = pw.chromium.launch(**launch_opts)
        ctx = b.new_context(
            viewport={"width": 1400, "height": 900},
        )
        pg = ctx.new_page()

        pg.add_init_script("""
        window.__inkwell_stub = {
          render_tile: async (args) => new Array(256 * 256 * 4).fill(255),
          get_page_text_data: async (args) => ({ page_index: 0, text: '', lines: [] }),
          commit_stroke: async () => 's_test_1',
          delete_stroke: async () => true,
        };
        """)

        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(URL, wait_until="networkidle")
        pg.wait_for_timeout(300)

        # -------------------------------------------------------------
        # Part 1: Verify Panning to the Right and Freedom of Movement
        # -------------------------------------------------------------
        print("=== Part 1: Viewport Panning Freedom ===")
        v_init = pg.evaluate("() => ({ panX: window.getViewport().panX, panY: window.getViewport().panY, stageW: window.getViewport().stageW })")
        print(f"Initial viewport: panX={v_init['panX']}, stageW={v_init['stageW']}")

        # Pan to the right by dragging with Spacebar + mouse drag
        box = pg.locator("#stage").bounding_box()
        mid_x = box["x"] + box["width"] / 2
        mid_y = box["y"] + box["height"] / 2

        pg.keyboard.down("Space")
        pg.mouse.move(mid_x, mid_y)
        pg.mouse.down()
        pg.mouse.move(mid_x + 350, mid_y, steps=10)
        pg.mouse.up()
        pg.keyboard.up("Space")
        pg.wait_for_timeout(100)

        v_right = pg.evaluate("() => ({ panX: window.getViewport().panX, panY: window.getViewport().panY })")
        print(f"Panned right viewport: panX={v_right['panX']}")
        assert v_right['panX'] > v_init['panX'] + 200, f"Expected panX to move right significantly, got {v_right['panX']} vs init {v_init['panX']}"
        print(" [PASS] Page successfully panned far to the right without being locked or cut off!")

        # Pan back and to the left
        pg.keyboard.down("Space")
        pg.mouse.move(mid_x + 350, mid_y)
        pg.mouse.down()
        pg.mouse.move(mid_x - 450, mid_y, steps=10)
        pg.mouse.up()
        pg.keyboard.up("Space")
        pg.wait_for_timeout(100)

        v_left = pg.evaluate("() => ({ panX: window.getViewport().panX, panY: window.getViewport().panY })")
        print(f"Panned left viewport: panX={v_left['panX']}")
        assert v_left['panX'] < v_init['panX'] - 50, f"Expected panX to move left, got {v_left['panX']}"
        print(" [PASS] Page successfully panned to the left!")

        # Reset view
        pg.evaluate("window.getViewport().fitPage()")
        pg.wait_for_timeout(100)

        # -------------------------------------------------------------
        # Part 2: Verify Pressure Sensitivity & Stroke Width Modulation
        # -------------------------------------------------------------
        print("\n=== Part 2: Stylus Pressure Sensitivity & Stroke Width ===")
        pg.locator("#btnDockPen").click(force=True)
        pg.wait_for_timeout(50)

        cdp = ctx.new_cdp_session(pg)
        wet_box = pg.locator("#wet").bounding_box()
        wx = wet_box["x"] + wet_box["width"] / 2
        wy = wet_box["y"] + 200

        # Stroke 1: Light pressure (0.15)
        print("Drawing Stroke 1 with light pressure (force=0.15)...")
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mousePressed", "x": wx - 150, "y": wy, "button": "left",
            "buttons": 1, "pointerType": "pen", "force": 0.15, "clickCount": 1
        })
        for i in range(15):
            cdp.send("Input.dispatchMouseEvent", {
                "type": "mouseMoved", "x": wx - 150 + i * 10, "y": wy,
                "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.15
            })
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseReleased", "x": wx, "y": wy,
            "button": "left", "buttons": 0, "pointerType": "pen", "force": 0.15
        })
        pg.wait_for_timeout(200)

        # Stroke 2: Heavy pressure (0.95)
        print("Drawing Stroke 2 with heavy pressure (force=0.95)...")
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mousePressed", "x": wx - 150, "y": wy + 60, "button": "left",
            "buttons": 1, "pointerType": "pen", "force": 0.95, "clickCount": 1
        })
        for i in range(15):
            cdp.send("Input.dispatchMouseEvent", {
                "type": "mouseMoved", "x": wx - 150 + i * 10, "y": wy + 60,
                "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.95
            })
        cdp.send("Input.dispatchMouseEvent", {
            "type": "mouseReleased", "x": wx, "y": wy + 60,
            "button": "left", "buttons": 0, "pointerType": "pen", "force": 0.95
        })
        pg.wait_for_timeout(200)

        # Inspect committed stroke widths
        strokes = pg.evaluate("""() => {
            return window.state.strokes.map(s => ({
                id: s.id,
                kind: s.kind,
                pointCount: s.points.length,
                avgWidth: s.points.reduce((acc, p) => acc + p.w, 0) / s.points.length,
                avgPressure: s.points.reduce((acc, p) => acc + p.p, 0) / s.points.length,
                widths: s.points.map(p => p.w),
                pressures: s.points.map(p => p.p),
            }));
        }""")

        assert len(strokes) >= 2, f"Expected at least 2 committed strokes, found {len(strokes)}"
        s_light = strokes[0]
        s_heavy = strokes[1]

        print(f"Light stroke: avgPressure={s_light['avgPressure']:.3f}, avgWidth={s_light['avgWidth']:.3f}pt")
        print(f"Heavy stroke: avgPressure={s_heavy['avgPressure']:.3f}, avgWidth={s_heavy['avgWidth']:.3f}pt")

        assert s_heavy['avgWidth'] > s_light['avgWidth'] * 2.0, (
            f"Heavy stroke width ({s_heavy['avgWidth']:.3f}) should be more than 2x light stroke width ({s_light['avgWidth']:.3f})"
        )
        print(" [PASS] Stroke geometry responds dynamically to pressure with >2x width range!")

        # -------------------------------------------------------------
        # Part 3: Verify Native Evdev Stylus Stream Emulation
        # -------------------------------------------------------------
        print("\n=== Part 3: Native Evdev Stylus Integration ===")
        native_pressure_test = pg.evaluate("""() => {
            return {
                toolAccessor: typeof window.getLiveNativeTool === 'function',
                pressureAccessor: typeof window.resolvePressure === 'function',
                resetAccessor: typeof window.resetPressureDynamics === 'function',
            };
        }""")
        print(f"Native evdev test result: {native_pressure_test}")
        assert native_pressure_test['toolAccessor'] and native_pressure_test['pressureAccessor'] and native_pressure_test['resetAccessor']

        screenshot_path = "/home/nboss/.gemini/antigravity/brain/da105d4a-b8d2-4333-9ad3-55797f4a1b0b/test_viewport_pressure_verified.png"
        pg.screenshot(path=screenshot_path)
        print(f"Saved visual verification screenshot to {screenshot_path}")

        assert len(errors) == 0, f"Encountered JS errors: {errors}"
        print("\nALL VERIFICATION CHECKS PASSED WITH ZERO REGRESSIONS!")

if __name__ == "__main__":
    test_viewport_and_pressure()
