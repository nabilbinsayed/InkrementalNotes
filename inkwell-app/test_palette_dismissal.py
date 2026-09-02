#!/usr/bin/env python3
import pathlib
import os
import sys
from playwright.sync_api import sync_playwright

SRC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src")

def run_tests():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--allow-file-access-from-files",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage"
            ]
        )
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()

        errors = []
        page.on("pageerror", lambda err: errors.append(str(err)))

        page.goto(pathlib.Path(SRC_DIR, "index.html").as_uri())
        page.wait_for_selector("#wet")
        page.wait_for_function("() => window.state !== undefined && window.toolbar !== undefined")

        def check(name, cond):
            status = "PASS" if cond else "FAIL"
            print(f"  [{status}] {name}")
            if not cond:
                sys.exit(1)

        print("\n=== P1: Open Palette Popover via Dock Button ===")
        page.click("#btnDockAddPreset")
        is_open = page.evaluate("!document.getElementById('propPopover').classList.contains('hidden')")
        check("Palette popover is visible after clicking dock button", is_open)

        print("\n=== P2: Choose Color & Width Settings ===")
        # Click Crimson Red swatch (color #dc2626)
        page.click(".swatch[data-color='#dc2626']")
        current_rgb = page.evaluate("window.state.penColor || window.state.color")
        check("Selecting crimson red swatch updates pen color", current_rgb is not None and current_rgb[0] > 0.8)

        # Click 6 pt width preset pill
        page.click(".btn-width-preset[data-width='6.0']")
        current_width = page.evaluate("window.state.penWidth")
        check("Selecting 6 pt preset updates pen width", current_width == 6.0)

        # Palette should still be open while interacting inside it
        is_still_open = page.evaluate("!document.getElementById('propPopover').classList.contains('hidden')")
        check("Palette remains open while configuring inside it", is_still_open)

        print("\n=== P3: Tap on Screen for Drawing Closes Palette ===")
        wet_box = page.locator("#wet").bounding_box()
        # Tap on canvas to draw
        page.mouse.move(wet_box['x'] + 100, wet_box['y'] + 100)
        page.mouse.down()
        is_closed_on_draw = page.evaluate("document.getElementById('propPopover').classList.contains('hidden')")
        check("Tapping on canvas to draw immediately closes palette popover", is_closed_on_draw)

        # Finish drawing stroke
        page.mouse.move(wet_box['x'] + 150, wet_box['y'] + 100)
        page.mouse.up()
        strokes = page.evaluate("window.state.strokes.length")
        check("Drawing stroke succeeds after palette auto-closes", strokes > 0)

        print("\n=== P4: Shortcut 'C' Toggles Palette ===")
        page.keyboard.press("c")
        is_open_c = page.evaluate("!document.getElementById('propPopover').classList.contains('hidden')")
        check("Pressing 'C' opens palette popover", is_open_c)

        page.keyboard.press("c")
        is_closed_c = page.evaluate("document.getElementById('propPopover').classList.contains('hidden')")
        check("Pressing 'C' again toggles palette popover closed", is_closed_c)

        print("\n=== P5: Escape Key Dismissal ===")
        page.keyboard.press("c")
        check("Re-opened with 'C'", page.evaluate("!document.getElementById('propPopover').classList.contains('hidden')"))

        page.keyboard.press("Escape")
        is_closed_esc = page.evaluate("document.getElementById('propPopover').classList.contains('hidden')")
        check("Pressing 'Escape' closes palette popover", is_closed_esc)

        print("\n=== P6: Click-Outside Dismissal ===")
        page.keyboard.press("c")
        check("Re-opened with 'C'", page.evaluate("!document.getElementById('propPopover').classList.contains('hidden')"))

        # Click on stage background outside popover and dock
        page.mouse.click(wet_box['x'] + 10, wet_box['y'] + 10)
        is_closed_outside = page.evaluate("document.getElementById('propPopover').classList.contains('hidden')")
        check("Clicking outside popover dismisses it cleanly", is_closed_outside)

        print(f"\nBrowser errors count: {len(errors)}")
        check("Zero browser errors throughout test", len(errors) == 0)

        browser.close()

if __name__ == "__main__":
    run_tests()
