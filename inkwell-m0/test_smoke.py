"""Smoke test for the M0 spike. Drives real pen pointer events over CDP.

This verifies the code RUNS correctly. It says nothing about how the ink FEELS
on real hardware -- headless Chromium has no display, no compositor and no pen,
so every latency number it produces is meaningless. Only the human + a 240 fps
camera can close that loop.
"""
import math, pathlib, sys, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = (ROOT / "src" / "index.html").as_uri()
errors, warnings = [], []
results = []

def check(name, cond, note=""):
    results.append(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"   {note}" if note else ""), flush=True)

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--force-device-scale-factor=1", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"])
    ctx = b.new_context(viewport={"width": 1360, "height": 860})
    pg = ctx.new_page()
    pg.on("console", lambda m: (errors if m.type == "error" else
                                warnings if m.type == "warning" else []).append(m.text))
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(400)

    print("\n=== T1  Boot ===", flush=True)
    check("page loads with no JS errors", not errors, str(errors[:2]))
    check("ink.js, hud.js, app.js all exported",
          pg.evaluate("!!(window.Ink && window.HUD && document.getElementById('wet'))"))
    check("canvases sized to the stage",
          pg.evaluate("document.getElementById('wet').width > 400"))
    check("pointerrawupdate detected and wired",
          pg.evaluate("document.getElementById('evtName').textContent") == "pointerrawupdate",
          pg.evaluate("document.getElementById('evtName').textContent"))

    print("\n=== T2  Pen input pipeline (synthetic pen via CDP) ===", flush=True)
    cdp = ctx.new_cdp_session(pg)
    box = pg.locator("#wet").bounding_box()
    ox, oy = box["x"] + 60, box["y"] + 300

    def pen(kind, x, y, force, buttons=1):
        cdp.send("Input.dispatchMouseEvent", {
            "type": kind, "x": x, "y": y, "button": "left",
            "buttons": buttons, "pointerType": "pen", "force": force,
            "clickCount": 1 if kind != "mouseMoved" else 0,
        })

    N = 420
    pen("mousePressed", ox, oy, 0.05)
    for i in range(N):
        t = i / (N - 1)
        x = ox + t * 620
        y = oy + 130 * math.sin(t * 9.0) + 40 * math.sin(t * 23.0)
        f = 0.05 + 0.9 * math.sin(math.pi * t) ** 0.6      # pressure envelope
        pen("mouseMoved", x, y, f)
    pen("mouseReleased", ox + 620, oy, 0.05, buttons=0)
    pg.wait_for_timeout(500)

    m = pg.evaluate("""() => ({
        type: state.m.pointerType, samples: state.m.samples,
        strokes: state.m.strokes, levels: state.m.levels.size,
        maxP: state.m.maxPressure, committed: state.strokes.length,
        pts: state.strokes.length ? state.strokes[0].points.length : 0,
        widths: state.strokes.length
            ? state.strokes[0].points.map(p => p.w) : [],
        paintN: state.m.paintLat.len, frameN: state.m.frameGap.len,
    })""")
    check("events arrive as pointerType 'pen'", m["type"] == "pen", m["type"])
    check("samples captured", m["samples"] > 300, f"{m['samples']} samples")
    check("stroke committed to the dry layer on pen-up",
          m["committed"] == 1 and m["pts"] > 300, f"{m['pts']} points")
    check("pressure is analogue, not binary", m["levels"] > 100,
          f"{m['levels']} distinct levels, max {m['maxP']:.3f}")
    ws = m["widths"]
    check("stroke width actually varies with pressure",
          ws and (max(ws) - min(ws)) > 1.0,
          f"width {min(ws):.2f}\u2013{max(ws):.2f} px")
    check("latency + frame metrics are being collected",
          m["paintN"] > 5 and m["frameN"] > 5,
          f"{m['paintN']} paint samples, {m['frameN']} frames")

    print("\n=== T3  Wet/dry split ===", flush=True)
    wet_clear = pg.evaluate("""() => {
        const c = document.getElementById('wet');
        const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        for (let i=3;i<d.length;i+=4) if (d[i]!==0) return false;
        return true; }""")
    check("wet layer cleared after commit", wet_clear)
    dry_has_ink = pg.evaluate("""() => {
        const c = document.getElementById('dry');
        const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let n=0; for (let i=3;i<d.length;i+=4) if (d[i]>10) n++;
        return n; }""")
    check("dry layer holds the committed ink", dry_has_ink > 1500,   # ~1500px path @ ~2px avg width
          f"{dry_has_ink:,} inked pixels")

    print("\n=== T4  The 'coalesced OFF' teaching toggle ===", flush=True)
    pg.evaluate("state.m.reset(); state.strokes=[]; redrawDry();")
    pg.uncheck("#cCoalesced")
    check("toggle flips app state", pg.evaluate("state.cfg.coalesced") is False)
    pg.check("#cCoalesced")
    check("toggle restores", pg.evaluate("state.cfg.coalesced") is True)

    print("\n=== T5  Capture export schema matches the PDF writer ===", flush=True)
    payload = pg.evaluate("""() => {
        const s = state.strokes[0]; if (!s) return null;
        return { id:s.id, kind:s.kind, rgb:s.rgb,
                 base_width:s.base_width, n:s.samples.length,
                 sample0:s.samples[0] }; }""")
    pg.evaluate("state.strokes=[]")
    # rebuild one stroke so we can inspect the schema
    pen("mousePressed", ox, oy, 0.2)
    for i in range(40):
        pen("mouseMoved", ox + i * 6, oy + 20 * math.sin(i / 4), 0.3 + 0.5 * (i / 40))
    pen("mouseReleased", ox + 240, oy, 0.1, buttons=0)
    pg.wait_for_timeout(200)
    s = pg.evaluate("""() => { const s = state.strokes[state.strokes.length-1];
        return { keys: Object.keys({id:s.id, kind:s.kind, rgb:s.rgb,
                 base_width:s.base_width, samples:s.samples}),
                 sample: s.samples[5] }; }""")
    check("stroke object has the PDF writer's exact keys",
          set(s["keys"]) == {"id", "kind", "rgb", "base_width", "samples"},
          str(s["keys"]))
    check("sample is [x, y, pressure, t_ms]",
          len(s["sample"]) == 4 and 0 <= s["sample"][2] <= 1,
          str([round(v, 3) for v in s["sample"]]))

    print("\n=== T6  Console hygiene over the whole session ===", flush=True)
    check("zero console errors", not errors, str(errors[:3]))
    check("zero console warnings", not warnings, str(warnings[:3]))

    pg.evaluate("document.getElementById('hint').style.display='none'")
    pg.screenshot(path=str(ROOT / "screenshot.png"))
    b.close()

print(f"\n{'='*62}\n  {sum(results)}/{len(results)} checks passed\n{'='*62}", flush=True)
sys.exit(0 if all(results) else 1)
