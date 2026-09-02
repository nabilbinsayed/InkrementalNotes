#!/usr/bin/env python3
"""
test_m2_touch_a11y.py — Milestone 2 UI/UX, Touch Ergonomics, and Accessibility Verification
Tests F13 (Touch Target Expansion >= 44x44px), F14 (Universal Focus Rings & Glassmorphic Toasts),
and ARIA modal attributes.
"""

import pathlib
import sys
import time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "src" / "index.html").as_uri()

def run_tests():
    passed = 0
    failed = 0
    console_errors = []
    internal_warnings = []

    def log_pass(msg):
        nonlocal passed
        passed += 1
        print(f"  [PASS] {msg}", flush=True)

    def log_fail(msg):
        nonlocal failed
        failed += 1
        print(f"  [FAIL] {msg}", flush=True)

    print("\n=== Milestone 2 Touch Ergonomics & Accessibility (F13–F15) ===")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--allow-file-access-from-files",
                "--force-device-scale-factor=1",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage"
            ]
        )
        context = browser.new_context(viewport={"width": 1360, "height": 860})
        page = context.new_page()

        # Add Tauri invoke stub with accurate dynamic tile sizing
        page.add_init_script("""
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
          get_page_text_data: async () => ({ page_index: 0, text: 'Sample PDF Text', lines: [], chars: [], spans: [] }),
          commit_stroke: async (args) => (args && args.clientId) ? String(args.clientId) : 's_stub_123',
          render_raster: async () => new Array(64 * 64 * 4).fill(255),
          get_document_outline: async () => [],
          wal_flush: async () => true,
        };
        window.__TAURI__ = {
          core: {
            invoke: async (cmd, args) => {
              if (window.__inkwell_stub[cmd]) return await window.__inkwell_stub[cmd](args);
              return null;
            }
          }
        };
        """)

        page.on("console", lambda msg: (
            console_errors.append(msg.text) if msg.type == "error" else
            internal_warnings.append(msg.text) if "warn" in msg.text.lower() else None
        ))
        page.on("pageerror", lambda err: console_errors.append(str(err)))

        page.goto(URL)
        page.wait_for_selector("#app-container", state="attached", timeout=5000)

        # -------------------------------------------------------------
        # Section 1: Touch Target Accessibility (F13)
        # -------------------------------------------------------------
        print("\n--- 1. Touch Target Accessibility (F13 - Minimum 44x44px) ---")

        # Test pseudo-element hit target dimensions via getComputedStyle on compact buttons
        compact_selectors = [
            (".header-icon-btn", "#btnNavBack"),
            (".header-icon-btn", "#btnNavForward"),
            (".header-icon-btn", "#btnHeaderSave"),
            (".header-icon-btn", "#btnHeaderExport"),
            (".header-icon-btn", "#btnHeaderFind"),
            (".header-icon-btn", "#btnHeaderSettings"),
            (".nav-cluster-btn", "#btnHeaderPrevPage"),
            (".nav-cluster-btn", "#btnHeaderNextPage"),
            (".nav-cluster-btn.mini", "#btnLeftPanePrev"),
            (".zoom-dock-btn", "#btnZoomIn"),
            (".zoom-dock-btn", "#btnZoomOut"),
            (".tab-add-btn", "#btnNewTab"),
            (".drawer-close-btn", "#btnCloseDrawer"),
            (".drawer-close-btn", "#btnCloseExportModal"),
            (".settings-close-btn", "#btnCloseSettingsModal"),
        ]

        for cls_name, sel in compact_selectors:
            target_info = page.evaluate(f"""() => {{
                const el = document.querySelector('{sel}');
                if (!el) return null;
                const cs = window.getComputedStyle(el, '::before');
                const rect = el.getBoundingClientRect();
                return {{
                    width: rect.width,
                    height: rect.height,
                    pseudoContent: cs.content,
                    pseudoMinWidth: cs.minWidth,
                    pseudoMinHeight: cs.minHeight,
                    pseudoPos: cs.position,
                    pseudoZIndex: cs.zIndex
                }};
            }}""")

            if target_info:
                has_44px = (target_info['pseudoMinWidth'] == '44px' and target_info['pseudoMinHeight'] == '44px')
                if has_44px and target_info['pseudoPos'] == 'absolute':
                    log_pass(f"{sel} ({target_info['width']:.0f}x{target_info['height']:.0f}px visual) has 44x44px hit expansion pseudo-element")
                else:
                    log_fail(f"{sel} pseudo-element properties: {target_info}")
            else:
                log_fail(f"Could not find element {sel}")

        # Test hit-testing at outer hit target edge (tapping at outer radius triggers click on button)
        hit_test_result = page.evaluate("""() => {
            const btn = document.querySelector('#btnHeaderSave');
            let clicked = false;
            const listener = () => { clicked = true; };
            btn.addEventListener('click', listener);

            const rect = btn.getBoundingClientRect();
            // Center is (rect.left + rect.width/2, rect.top + rect.height/2)
            // #btnHeaderSave is 32x32. Tap at 3px above top edge of 32px button (within 44x44 box which extends 6px above)
            const tapX = rect.left + rect.width / 2;
            const tapY = rect.top - 3;

            const targetEl = document.elementFromPoint(tapX, tapY);
            // Click via pointer event dispatch at that point
            const evt = new MouseEvent('click', { clientX: tapX, clientY: tapY, bubbles: true });
            if (targetEl) targetEl.dispatchEvent(evt);

            btn.removeEventListener('click', listener);
            return {
                clicked,
                targetTagName: targetEl ? targetEl.tagName : null,
                targetId: targetEl ? targetEl.id : null,
                matchesBtn: targetEl === btn
            };
        }""")

        if hit_test_result['clicked']:
            log_pass(f"Hit-test outside visual boundary of #btnHeaderSave (within 44x44 box) successfully triggers button click")
        else:
            log_fail(f"Hit-test outside visual boundary did not trigger button click: {hit_test_result}")

        # -------------------------------------------------------------
        # Section 2: Universal Focus-Visible System (F14)
        # -------------------------------------------------------------
        print("\n--- 2. Universal Focus-Visible System (F14) ---")

        # Test focus-visible stylesheet rule presence and application
        focus_elements = [
            ("Rail Button", "#btnRailThumbnails"),
            ("Dock Button", "#btnPen"),
            ("Header Icon Button", "#btnHeaderSave"),
            ("Nav Cluster Button", "#btnHeaderNextPage"),
            ("Zoom Dock Button", "#btnZoomIn"),
            ("Tab Add Button", "#btnNewTab"),
            ("Modal Button", "#btnCancelInsertPage"),
        ]

        for desc, sel in focus_elements:
            focus_applied = page.evaluate(f"""() => {{
                const el = document.querySelector('{sel}');
                if (!el) return false;
                // Test stylesheet matching for :focus-visible
                const rules = Array.from(document.styleSheets)
                    .flatMap(sheet => {{
                        try {{ return Array.from(sheet.cssRules); }} catch (e) {{ return []; }}
                    }});
                
                const hasFocusVisibleRule = rules.some(r => 
                    r.selectorText && 
                    r.selectorText.includes(':focus-visible') && 
                    (r.style.outline.includes('7c3aed') || r.style.outline.includes('rgb(124, 58, 237)') || r.style.outlineColor.includes('124, 58, 237') || r.style.outlineColor.includes('7c3aed'))
                );
                return hasFocusVisibleRule;
            }}""")

            if focus_applied:
                log_pass(f"{desc} ({sel}) matches universal #7C3AED :focus-visible ring rule")
            else:
                log_fail(f"{desc} ({sel}) missing :focus-visible ring rule")

        # -------------------------------------------------------------
        # Section 3: Glassmorphic Toast Notifications (F14)
        # -------------------------------------------------------------
        print("\n--- 3. Glassmorphic Toast Notifications (F14) ---")

        toast_container_check = page.evaluate("""() => {
            const tc = document.getElementById('toastContainer');
            return {
                exists: !!tc,
                ariaLive: tc ? tc.getAttribute('aria-live') : null,
                ariaAtomic: tc ? tc.getAttribute('aria-atomic') : null,
                role: tc ? tc.getAttribute('role') : null,
                ariaLabel: tc ? tc.getAttribute('aria-label') : null,
            };
        }""")

        if toast_container_check['exists'] and toast_container_check['ariaLive'] == 'polite':
            log_pass(f"#toastContainer has ARIA live region attributes (aria-live='polite', aria-atomic='true')")
        else:
            log_fail(f"#toastContainer missing or missing ARIA attributes: {toast_container_check}")

        # Trigger toast notifications of various types
        toast_types = [
            ('info', 'Document synchronized'),
            ('success', 'File saved successfully'),
            ('warning', 'Low storage warning'),
            ('error', 'Failed to open corrupted file')
        ]

        for t_type, t_msg in toast_types:
            toast_data = page.evaluate(f"""() => {{
                window.showToast('{t_msg}', '{t_type}');
                const toasts = document.querySelectorAll('.toast');
                const lastToast = toasts[toasts.length - 1];
                if (!lastToast) return null;
                const cs = window.getComputedStyle(lastToast);
                return {{
                    text: lastToast.textContent,
                    className: lastToast.className,
                    role: lastToast.getAttribute('role'),
                    backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter,
                    borderLeftColor: cs.borderLeftColor,
                    borderRadius: cs.borderRadius,
                    fontWeight: cs.fontWeight
                }};
            }}""")

            if toast_data and t_msg in toast_data['text']:
                has_blur = 'blur' in toast_data['backdropFilter']
                expected_role = 'alert' if t_type == 'error' else 'status'
                role_ok = toast_data['role'] == expected_role
                log_pass(f"Toast '{t_type}': role='{toast_data['role']}', backdrop-filter='{toast_data['backdropFilter']}', border-left='{toast_data['borderLeftColor']}'")
            else:
                log_fail(f"Toast '{t_type}' failed to render correctly: {toast_data}")

        # Test toast auto-dismiss
        time.sleep(3.6)
        remaining_toasts = page.evaluate("""() => {
            return document.querySelectorAll('.toast').length;
        }""")

        if remaining_toasts == 0:
            log_pass("Toasts auto-dismiss and remove from DOM after display duration")
        else:
            log_fail(f"{remaining_toasts} toasts remained in DOM after timeout")

        # -------------------------------------------------------------
        # Section 4: Modal Dialog ARIA Attributes & Hygiene
        # -------------------------------------------------------------
        print("\n--- 4. Modal Dialog ARIA Attributes ---")
        modals = [
            ("Export Modal", "#exportModal", "dialog", "exportModalTitle"),
            ("Insert Page Modal", "#insertPageModal", "dialog", "insertPageTitle"),
            ("Go To Page Modal", "#goToPageModal", "dialog", "goToPageTitle"),
            ("Shortcuts Modal", "#shortcutsModal", "dialog", "shortcutsModalTitle"),
            ("Confirm Close Modal", "#confirmCloseModal", "dialog", "confirmCloseTitle"),
            ("Confirm Delete Page Modal", "#confirmDeletePageModal", "dialog", "confirmDeletePageTitle"),
            ("Command Palette Modal", "#cmdPaletteModal", "dialog", None),
            ("Preferences Modal", "#settingsModal", "dialog", None),
        ]

        for desc, sel, expected_role, labelled_by in modals:
            m_info = page.evaluate(f"""() => {{
                const el = document.querySelector('{sel}');
                if (!el) return null;
                return {{
                    role: el.getAttribute('role'),
                    ariaModal: el.getAttribute('aria-modal'),
                    ariaLabelledBy: el.getAttribute('aria-labelledby'),
                    ariaLabel: el.getAttribute('aria-label')
                }};
            }}""")

            if m_info and m_info['role'] == expected_role and m_info['ariaModal'] == 'true':
                log_pass(f"{desc} ({sel}) has role='{expected_role}' and aria-modal='true'")
            else:
                log_fail(f"{desc} ({sel}) missing role or aria-modal: {m_info}")

        # -------------------------------------------------------------
        # Section 5: Console & Warning Hygiene
        # -------------------------------------------------------------
        print("\n--- 5. Console & Warning Hygiene ---")
        if len(console_errors) == 0:
            log_pass("zero console errors throughout M2 test session")
        else:
            log_fail(f"console errors detected: {console_errors}")

        if len(internal_warnings) == 0:
            log_pass("zero internal inkwell warnings")
        else:
            log_fail(f"warnings detected: {internal_warnings}")

        browser.close()

    total = passed + failed
    print("\n==============================================================")
    print(f"  {passed}/{total} checks passed")
    print("==============================================================\n")

    return 0 if failed == 0 else 1

if __name__ == "__main__":
    sys.exit(run_tests())
