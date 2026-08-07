# Inkwell M0 — Latency Spike

**This is a gate, not a feature.** A blank window, one pressure-sensitive stroke,
and instrumentation. If this doesn't feel right on your Huion H640P, nothing built
on top of it will, and you should stop before writing a PDF parser.

---

## Run it in 30 seconds (no toolchain)

Double-click **`src/index.html`**. It opens in your default browser.

Use **Edge** if you can — Edge is Chromium/WebView2, which is the *exact* engine
Tauri uses on Windows. So this measures the real thing.

There is no build step. No npm, no bundler, no ES modules. Deliberately.

## Run it as a real desktop app

Prereqs: [Rust](https://rustup.rs) + [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).
On Windows that means Visual Studio Build Tools and WebView2 (already on Win11).

```bash
cargo install tauri-cli --version "^2"
cd src-tauri
cargo tauri dev          # first build takes a few minutes
```

The Rust host applies WebView2 flags that matter for latency (see `src/main.rs`) —
expect slightly better and much more *consistent* numbers than plain Edge.

---

## Before you measure: check your driver

The single most common false result is the tablet reporting as a mouse.

1. Open the **Huion driver** → enable **Windows Ink**. Leave it on.
   (Counterintuitive if you've read art forums — but WinTab costs you event
   coalescing and prediction, which matter far more than 8192 vs 1024 pressure levels.)
2. Map the tablet to **one monitor only**, not the desktop span.
3. Disable any "pen filtering" / "cursor smoothing" in the driver. You want raw
   data; this app does its own filtering and you need to be able to turn it off.
4. Plug the laptop in and set the power plan to **High Performance**. Battery
   saver throttles the GPU and destroys frame pacing.
5. Note your display refresh rate. 60 Hz puts a hard 16.7 ms floor under you.

If the HUD says `Pointer type: mouse`, stop and fix step 1.

---

## How to run the test

1. Scribble **hard for about 20 seconds** — fast strokes, slow strokes, heavy,
   feather-light, tight circles, long sweeps. The gate needs ~200 samples.
2. Read the verdict at the top of the panel.
3. Read the diagnostics. They translate bad numbers into the actual fix.

### The five gates

| Gate | Threshold | Why |
|---|---|---|
| Pointer type | `pen` | Anything else means no pressure and 60 Hz sampling |
| Sample rate | ≥ 150 Hz | H640P reports at 233 Hz. Under 150 means you're dropping data, which is what makes fast curves look polygonal |
| evt→paint p95 | ≤ 25 ms | The app-side latency budget |
| Frame jitter (σ) | ≤ 3.0 ms | **Inconsistency reads as lag far more than constant latency does** |
| Pressure levels | ≥ 200 | Confirms real analogue pressure, not an on/off switch |

### The four toggles — do these experiments

They're not settings. They're the experiment.

- **Coalesced events OFF.** Scribble fast. Watch the curves go polygonal and the
  sample rate collapse to ~60 Hz. *This is the bug in naive implementations.*
  Turn it back on and the difference is obvious.
- **pointerrawupdate OFF** → falls back to `pointermove`. Usually a smaller but
  measurable regression.
- **Desynchronized canvas OFF.** Canvas goes through the normal compositor path.
  On most machines you can feel this one.
- **Predicted events ON.** Visually cancels ~8 ms, but overshoots on sharp
  direction changes. Decide for yourself whether the trade is worth it. Prediction
  is drawn only in the wet layer and is never committed to the stroke.

Also worth playing with: **min cutoff** and **beta** on the One-Euro filter.
Drag min cutoff to 0.2 and feel the ink lag behind the cursor; that's what
over-smoothing costs you.

---

## Ground truth: the 240 fps test

**The HUD numbers are a floor, not the truth.** JavaScript cannot observe the
compositor, display scanout, or LCD response — add roughly 8–20 ms on a 60 Hz panel.

So do this, once:

1. Set your phone camera to **240 fps** slow motion (4.17 ms per frame).
2. Frame the shot so both the **pen tip on the tablet** and the **screen** are visible.
3. Move the pen in a sharp, sudden direction change.
4. Step through frame by frame. Count frames between the tip changing direction
   and the ink changing direction. × 4.17 ms = your real latency.
5. **Write that number in this README.** Re-measure at every milestone.

This is the only honest number, and it's the one measurement no coding agent can
ever do for you.

---

## Exporting a capture

**Export capture JSON** downloads every stroke plus the session metrics.

The stroke schema (`[x, y, pressure, t_ms]`) is intentionally identical to the one
the single-PDF proof consumes — so you can turn a real Huion capture into a real
annotated PDF by swapping the synthetic stroke list in `poc_build.py` for the
`strokes` array from your capture file. No glue code.

Keep your captures. They become the replay corpus for latency regression tests
later: a recorded stroke replayed through the pipeline, with p99 checked in CI.

---

## What is deliberately NOT here

No PDF. No file format. No save. No tools. No zoom. No pan. No UI polish.

Every one of those is easier than this, and every one of them is worthless if this
step fails. Resist the urge — and resist the agent's urge — to add them. If your
coding agent starts scaffolding a PDF viewer, stop it and point it back at this file.

---

## Layout

```
src/
  index.html    markup + HUD
  styles.css    dark-first, no framework
  ink.js        One-Euro filter, Stroke, variable-width ribbon renderer
  hud.js        metrics, gate thresholds, diagnostics
  app.js        pointer pipeline, wet/dry canvases, controls
src-tauri/
  src/main.rs   window + WebView2 latency flags. Nothing else, on purpose.
```

### The two ideas worth internalising

**Wet/dry split.** The in-progress stroke lives on its own throwaway canvas
(`#wet`). Only new segments are drawn, incrementally, never a full clear. On
pen-up the stroke is committed to `#dry`, which is only ever fully redrawn on
resize. Redrawing the whole scene per input sample is the #1 structural cause of
laggy ink, and it's exactly what `QGraphicsView`-based apps do.

**Ink is a filled ribbon, not a stroked line.** A stroked line has one constant
width, so pressure is impossible with it. We build the outline of the varying-width
shape and fill it. The same maths is reused verbatim when exporting to PDF, so
what you see on screen and what lands in the file can never diverge.
