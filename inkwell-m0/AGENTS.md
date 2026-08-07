# AGENTS.md — rules for coding agents on this repo

Read this before making any change. It exists to stop well-intentioned agents from
destroying the one property this project is built around.

## Where you are

This repo is at **milestone M0**: a latency spike. See `README.md` for what that
means and `SPEC.md` (in the project root, if present) for the full design.

## Hard rules

1. **Do not add features.** No PDF loading, no save, no toolbar, no zoom, no pan,
   no tool palette, no settings persistence, no state management library. M0 ends
   when the measured latency gate passes on real hardware. If asked to "improve the
   app", improve the *measurement* or the *ink quality*, nothing else.

2. **Never put work in the pointer handler.** `onMove` in `src/app.js` runs up to
   233 times per second. Inside it, do not: allocate in a loop, call
   `getBoundingClientRect` more than once per event, touch the DOM, run
   `JSON.stringify`, log to console, or trigger layout. If you need a value, cache
   it on pointerdown.

3. **Never redraw the whole scene mid-stroke.** The wet/dry canvas split is
   load-bearing. `#dry` is only fully redrawn on resize. If you find yourself
   calling `redrawDry()` from a pointer handler, you have made a mistake.

4. **Ink is a filled ribbon, never a stroked line.** Do not "simplify" the segment
   quads in `ink.js` into `ctx.lineTo` + `ctx.stroke()`. That silently deletes
   pressure sensitivity, which is the entire point.

5. **Do not introduce a build step.** No bundler, no ES modules, no npm, no
   TypeScript compile, no CDN dependencies. `src/index.html` must keep working
   when double-clicked from the filesystem, offline. This is a testing requirement,
   not a preference.

6. **Do not change gate thresholds to make the gate pass.** They are in
   `hud.js:THRESHOLDS`. If a threshold is genuinely wrong, say so and explain why;
   do not quietly edit it.

7. **Do not claim the latency is good.** You cannot measure it. You have no pen and
   no camera. Report what the code does; let the human report how it feels.

## Preferred changes

- Better diagnostics in `hud.js:diagnose()` — more ways to translate a bad number
  into the specific fix.
- More accurate measurement.
- Ink quality: joins, caps, taper, filter tuning.
- Reducing work per sample.

## Definition of done for any change

- `src/index.html` still opens correctly by double-click, offline.
- Zero console errors or warnings during a 30-second scribble.
- Sample rate does not regress.
- You state plainly which of your claims you verified and which you did not.
