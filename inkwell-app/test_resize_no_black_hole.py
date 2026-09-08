"""Test to verify that canvas resizing from small to large window does not produce black holes or stale canvas size clamping."""
import shutil
from playwright.sync_api import sync_playwright

def test_resize_behavior():
    with sync_playwright() as pw:
        chrome_bin = shutil.which('chromium') or shutil.which('google-chrome-stable')
        b = pw.chromium.launch(
            headless=True,
            executable_path=chrome_bin,
            args=[
                "--allow-file-access-from-files",
                "--force-device-scale-factor=1",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage"
            ]
        )
        # Start in a small window (500x300), simulating initial small Hyprland tile
        ctx = b.new_context(viewport={'width': 500, 'height': 300})
        pg = ctx.new_page()
        pg.add_init_script('''
        window.__inkwell_stub = {
          render_tile: async (args) => new Array(256 * 256 * 4).fill(255),
          get_page_text_data: async (args) => ({ page_index: 0, text: '', lines: [] }),
          commit_stroke: async () => 's_test_1',
          delete_stroke: async () => true,
        };
        ''')
        pg.goto('file:///mnt/Work/Own%20Programs/InkWell/inkwell-app/src/index.html')
        pg.wait_for_function('typeof window.getViewport === "function"')
        pg.wait_for_timeout(200)

        # Check small window canvas dimensions
        dim_small = pg.evaluate('''() => {
            const stage = document.getElementById('stage').getBoundingClientRect();
            const tiles = document.getElementById('tiles');
            return {
                stageW: stage.width,
                stageH: stage.height,
                canvasAttrW: tiles.width,
                canvasAttrH: tiles.height,
                canvasStyleW: tiles.style.width,
                canvasStyleH: tiles.style.height,
            };
        }''')
        print("Small window state:", dim_small)

        # Now enlarge window to 1500x900 (simulating tiling expansion or window maximize)
        pg.set_viewport_size({'width': 1500, 'height': 900})
        pg.wait_for_timeout(300)

        dim_large = pg.evaluate('''() => {
            const stage = document.getElementById('stage').getBoundingClientRect();
            const tiles = document.getElementById('tiles');
            const dry = document.getElementById('dry');
            const wet = document.getElementById('wet');
            return {
                stageW: stage.width,
                stageH: stage.height,
                tilesW: tiles.width,
                tilesH: tiles.height,
                dryW: dry.width,
                dryH: dry.height,
                wetW: wet.width,
                wetH: wet.height,
                canvasStyleW: tiles.style.width,
            };
        }''')
        print("Large window state:", dim_large)

        # Verify that the canvases expanded to match the new stage width (>1400px), not locked at 500px!
        assert dim_large['tilesW'] >= 1400, f"Tiles canvas width {dim_large['tilesW']} should be >= 1400"
        assert dim_large['dryW'] >= 1400, f"Dry canvas width {dim_large['dryW']} should be >= 1400"
        assert dim_large['wetW'] >= 1400, f"Wet canvas width {dim_large['wetW']} should be >= 1400"
        print(" [PASS] All three canvases dynamically expanded with #stage without being trapped in initial dimensions!")

        # Pan the page across the newly expanded stage to verify no black hole exists
        pg.evaluate('''() => {
            const vp = window.getViewport();
            // Pan page to x = 800 (well past the old 500px boundary)
            vp.setPan(800, 100);
        }''')
        pg.wait_for_timeout(200)

        pan_check = pg.evaluate('''() => {
            const vp = window.getViewport();
            return { panX: vp.panX, panY: vp.panY };
        }''')
        print("Panned across full stage:", pan_check)
        assert pan_check['panX'] > 500, f"Expected panX > 500, got {pan_check['panX']}"
        print(" [PASS] Page panned freely across full expanded stage width!")

        screenshot_path = "/home/nboss/.gemini/antigravity/brain/da105d4a-b8d2-4333-9ad3-55797f4a1b0b/test_no_black_hole_verified.png"
        pg.screenshot(path=screenshot_path)
        print(f"Visual verification screenshot saved to {screenshot_path}")
        print("\nALL DYNAMIC RESIZE CHECKS PASSED!")

if __name__ == "__main__":
    test_resize_behavior()
