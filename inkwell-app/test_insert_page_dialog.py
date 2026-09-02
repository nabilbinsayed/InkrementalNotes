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
        page.wait_for_function("() => window.state !== undefined && window.documentOps !== undefined")

        def check(name, cond):
            status = "PASS" if cond else "FAIL"
            print(f"  [{status}] {name}")
            if not cond:
                sys.exit(1)

        print("\n=== D1: Open Insert Page Modal ===")
        page.click("#btnHeaderAddPage")
        page.screenshot(path="/home/nboss/.gemini/antigravity/brain/6676519c-ff0b-4674-a797-09e7a4c1dd7f/insert_page_dialog.png")
        is_open = page.evaluate("!document.getElementById('insertPageModal').classList.contains('hidden')")
        check("Insert Page modal opens on header add page click", is_open)

        print("\n=== D2: Verify Customization Options Visibility ===")
        pos_vis = page.evaluate("!document.getElementById('insertPositionSelect').closest('.form-group').classList.contains('hidden')")
        check("Insertion Position control is visible", pos_vis)

        size_vis = page.evaluate("!document.getElementById('insertPaperSizeSelect').closest('.form-group').classList.contains('hidden')")
        check("Paper Size control is visible", size_vis)

        orient_vis = page.evaluate("!document.querySelector('input[name=\"pageOrientation\"]').closest('.form-group').classList.contains('hidden')")
        check("Orientation control is visible", orient_vis)

        tpl_vis = page.evaluate("!document.getElementById('insertTemplateSelect').closest('.form-group').classList.contains('hidden')")
        check("Paper Template control is visible", tpl_vis)

        print("\n=== D3: Custom Dimensions Toggle ===")
        custom_hidden_init = page.evaluate("document.getElementById('customDimRow').classList.contains('hidden')")
        check("Custom dimensions row is hidden by default", custom_hidden_init)

        page.select_option("#insertPaperSizeSelect", "custom")
        custom_shown = page.evaluate("!document.getElementById('customDimRow').classList.contains('hidden')")
        check("Selecting 'custom' reveals custom dimensions inputs", custom_shown)

        page.select_option("#insertPaperSizeSelect", "letter")
        custom_rehidden = page.evaluate("document.getElementById('customDimRow').classList.contains('hidden')")
        check("Selecting preset re-hides custom dimensions", custom_rehidden)

        print("\n=== D4: Insert Page with Cornell Template & Landscape ===")
        init_page_count = page.evaluate("window.state.pageInfos.length")
        
        # Select Cornell template
        page.select_option("#insertTemplateSelect", "cornell")
        # Select Landscape orientation
        page.click("input[name='pageOrientation'][value='landscape'] + span")
        # Select After Current Page
        page.select_option("#insertPositionSelect", "after_current")

        # Submit form
        page.click("#btnConfirmInsertPage")
        
        # Verify modal closes
        is_closed = page.evaluate("document.getElementById('insertPageModal').classList.contains('hidden')")
        check("Modal closes after submitting", is_closed)

        # Verify page count incremented
        new_page_count = page.evaluate("window.state.pageInfos.length")
        check("New page added to state.pageInfos", new_page_count == init_page_count + 1)

        # Verify new page info properties
        inserted_page = page.evaluate("window.state.pageInfos[1]")
        print("Inserted page info:", inserted_page)
        check("Inserted page template is 'cornell'", inserted_page.get("template") == "cornell")
        check("Inserted page is landscape (width > height)", inserted_page.get("width_pt", 0) > inserted_page.get("height_pt", 0))

        # Verify viewport layout updated
        layout_len = page.evaluate("window.getViewport().pageLayouts.length")
        check("Viewport document layout updated with new page", layout_len == new_page_count)

        print("\n=== D5: Dismissal with Cancel & Escape ===")
        page.click("#btnHeaderAddPage")
        check("Modal re-opened", page.evaluate("!document.getElementById('insertPageModal').classList.contains('hidden')"))
        page.click("#btnCancelInsertPage")
        check("Cancel button dismisses modal", page.evaluate("document.getElementById('insertPageModal').classList.contains('hidden')"))

        page.click("#btnHeaderAddPage")
        check("Modal re-opened", page.evaluate("!document.getElementById('insertPageModal').classList.contains('hidden')"))
        page.keyboard.press("Escape")
        check("Escape key dismisses modal", page.evaluate("document.getElementById('insertPageModal').classList.contains('hidden')"))

        print(f"\nBrowser errors count: {len(errors)}")
        check("Zero browser errors throughout test", len(errors) == 0)

        browser.close()

if __name__ == "__main__":
    run_tests()
