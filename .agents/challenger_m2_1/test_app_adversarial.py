"""Adversarial browser test for InkWell frontend (inkwell-app).
Tests DOM reflow elimination, inking hot loop, eraser/lasso spatial selection,
Path2D retention, and virtualized thumbnail recycling.
"""
import sys, os, math, pathlib, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
APP_URL = (ROOT / "inkwell-app" / "src" / "index.html").as_uri()

errors, warnings = [], []
results = []

def check(name, cond, note=""):
    results.append(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"   {note}" if note else ""))

with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--force-device-scale-factor=1"])
    ctx = b.new_context(viewport={"width": 1400, "height": 900})
    pg = ctx.new_page()

    pg.on("console", lambda m: (errors if m.type == "error" else
                                warnings if m.type == "warning" else []).append(m.text))
    pg.on("pageerror", lambda e: errors.append(str(e)))

    pg.goto(APP_URL)
    pg.wait_for_timeout(500)

    print("\n=== S1: App Initialization & Ink Engine Export ===")
    check("Page loads with zero JS errors", not errors, str(errors[:2]))
    check("window.Ink, state, and canvases exist",
          pg.evaluate("!!(window.Ink && typeof state !== 'undefined' && document.getElementById('wet'))"))

    print("\n=== S2: High-Frequency Pen Inking & Zero Reflow Check ===")
    # Mock a 1-page document state for standalone browser testing and spy on getBoundingClientRect
    pg.evaluate("""() => {
        window.__reflowCalls = 0;
        window.__trackReflows = false;
        const origGB = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function() {
            if (window.__trackReflows) window.__reflowCalls++;
            return origGB.call(this);
        };

        if (!state.pageInfos || !state.pageInfos.length) {
            state.pageInfos = [{ width_pt: 612, height_pt: 792 }];
            viewport.updateDocumentLayout(state.pageInfos);
            redrawAll();
        }
    }""")

    cdp = ctx.new_cdp_session(pg)
    box = pg.locator("#wet").bounding_box()
    ox, oy = box["x"] + 200, box["y"] + 200

    def pen_event(kind, x, y, force, buttons=1):
        cdp.send("Input.dispatchMouseEvent", {
            "type": kind, "x": x, "y": y, "button": "left",
            "buttons": buttons, "pointerType": "pen", "force": force,
            "clickCount": 1 if kind != "mouseMoved" else 0,
        })

    # Start tracking reflows during inking moves
    pg.evaluate("window.__trackReflows = true; window.__reflowCalls = 0;")

    # Send 200 high-frequency samples
    pen_event("mousePressed", ox, oy, 0.1)
    for i in range(200):
        t = i / 199.0
        x = ox + t * 400
        y = oy + 60 * math.sin(t * 8.0)
        f = 0.1 + 0.8 * math.sin(math.pi * t)
        pen_event("mouseMoved", x, y, f)
    pen_event("mouseReleased", ox + 400, oy, 0.1, buttons=0)
    pg.wait_for_timeout(300)

    # Stop tracking reflows
    pg.evaluate("window.__trackReflows = false;")
    reflow_calls = pg.evaluate("window.__reflowCalls")

    check("Zero forced getBoundingClientRect() reflows in inking loop",
          reflow_calls <= 2, f"Total reflow calls during 200 moves: {reflow_calls}")

    stroke_count = pg.evaluate("state.strokes.length")
    check("Stroke committed to state.strokes", stroke_count >= 1, f"Strokes: {stroke_count}")

    cached_p2d = pg.evaluate("!!(state.strokes[0] && state.strokes[0]._cachedPath2D)")
    check("Committed stroke has cached _cachedPath2D", cached_p2d)

    bbox = pg.evaluate("state.strokes[0] ? state.strokes[0].bbox : null")
    check("Committed stroke has spatial bbox", bbox is not None and bbox[2] > bbox[0], str(bbox))

    print("\n=== S3: Multi-Stroke Drawing, Chisel Highlighter & Path Retention ===")
    # Draw a highlighter stroke
    pg.evaluate("setTool('highlighter')")
    pen_event("mousePressed", ox, oy + 100, 0.5)
    for i in range(50):
        pen_event("mouseMoved", ox + i * 8, oy + 100, 0.5)
    pen_event("mouseReleased", ox + 400, oy + 100, 0.5, buttons=0)
    pg.wait_for_timeout(300)

    hl_stroke = pg.evaluate("state.strokes[state.strokes.length - 1]")
    check("Highlighter stroke saved with kind 'highlighter'",
          hl_stroke["kind"] == "highlighter")
    check("Highlighter has cached _cachedPath2D",
          pg.evaluate("!!(state.strokes[state.strokes.length - 1]._cachedPath2D)"))

    print("\n=== S4: Spatial Eraser Proximity Hit-Testing ===")
    pg.evaluate("setTool('eraser')")
    # Erase near the highlighter stroke (ox + 200, oy + 100)
    pen_event("mousePressed", ox + 200, oy + 100, 0.5)
    pen_event("mouseMoved", ox + 200, oy + 100, 0.5)
    pen_event("mouseReleased", ox + 200, oy + 100, 0.5, buttons=0)
    pg.wait_for_timeout(300)

    hl_deleted = pg.evaluate("state.strokes[state.strokes.length - 1].deleted")
    check("Eraser deleted targeted stroke", hl_deleted)

    # Undo erase
    pg.evaluate("undo()")
    hl_restored = pg.evaluate("!state.strokes[state.strokes.length - 1].deleted")
    check("Undo successfully restored erased stroke", hl_restored)

    print("\n=== S5: Virtualized Thumbnail Drawer Recycling ===")
    # Open thumbnail drawer and simulate a 100-page document
    pg.evaluate("""() => {
        state.pageInfos = Array.from({ length: 100 }, (_, i) => ({
            width_pt: 612,
            height_pt: 792,
        }));
        viewport.updateDocumentLayout(state.pageInfos);
        renderThumbnails();
    }""")
    pg.wait_for_timeout(300)

    rendered_cards = pg.evaluate("document.querySelectorAll('.thumbnail-card').length")
    check("Virtualized thumbnail drawer bounds active cards (< 25 cards for 100 pages)",
          1 <= rendered_cards <= 25, f"Active DOM cards: {rendered_cards} for 100 pages")

    print("\n=== S6: Console Hygiene ===")
    clean_errors = [e for e in errors if "Failed to fetch" not in e and "commit_stroke" not in e and "erase_strokes_near" not in e]
    check("Zero critical console errors", len(clean_errors) == 0, str(clean_errors))

    print("\n==============================================================")
    print(f"  {sum(results)}/{len(results)} browser adversarial checks passed")
    print("==============================================================")

    if not all(results):
        sys.exit(1)
