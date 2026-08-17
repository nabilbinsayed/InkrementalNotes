/* ============================================================================
 * app.js — wiring, pointer pipeline, render loop.
 *
 * THE FOUR THINGS THAT DECIDE WHETHER WEB INK FEELS GOOD:
 *   1. getContext('2d', { desynchronized: true })   -> low-latency canvas path
 *   2. 'pointerrawupdate' instead of 'pointermove'  -> higher event frequency
 *   3. getCoalescedEvents()                         -> ALL device samples, not 1/frame
 *   4. draw synchronously in the handler            -> don't wait for rAF
 * Every one is a toggle below so you can feel the difference yourself.
 * ========================================================================== */

const $ = id => document.getElementById(id);

const state = {
  cfg: {
    baseWidth: 3.2,
    rgb: [0.08, 0.09, 0.14],
    gamma: 1.0,
    minCutoff: 1.7,
    beta: 0.02,
    smoothing: true,
    coalesced: true,
    rawUpdate: true,
    syncDraw: true,
    prediction: false,
    desync: true,
    penOnly: false,
  },
  strokes: [],
  cur: null,
  dpr: 1,
  m: new HUD.Metrics(),
};

let dry, wet, dctx, wctx;

/* ---- canvas setup --------------------------------------------------------- */
function makeCtx(canvas) {
  return canvas.getContext('2d', {
    desynchronized: state.cfg.desync,   // the single most important flag
    alpha: true,
  });
}

function resize() {
  const host = $('stage');
  const r = host.getBoundingClientRect();
  state.dpr = Math.max(1, window.devicePixelRatio || 1);
  for (const c of [dry, wet]) {
    c.width = Math.round(r.width * state.dpr);
    c.height = Math.round(r.height * state.dpr);
    c.style.width = r.width + 'px';
    c.style.height = r.height + 'px';
  }
  dctx = makeCtx(dry); wctx = makeCtx(wet);
  for (const ctx of [dctx, wctx]) ctx.scale(state.dpr, state.dpr);
  redrawDry();
}

function redrawDry() {
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, dry.width, dry.height);
  dctx.scale(state.dpr, state.dpr);
  for (const s of state.strokes) Ink.drawStroke(dctx, s);
}

function clearWet() {
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.clearRect(0, 0, wet.width, wet.height);
  wctx.scale(state.dpr, state.dpr);
}

/* ---- pointer pipeline ----------------------------------------------------- */
function localXY(e) {
  const r = wet.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

/** Feed one device sample into the current stroke and draw the new segment. */
function consume(e, predicted = false) {
  if (!state.cur) return;
  const [x, y] = localXY(e);
  const p = e.pressure > 0 ? e.pressure : 0.5;
  const prev = state.cur.last;
  const pt = state.cur.push(x, y, p, e.timeStamp);
  if (!pt) return;
  if (!predicted) state.m.onSample(e.timeStamp, p);

  wctx.fillStyle = state.cur.cssColor || `rgb(${state.cur.rgb.map(v => Math.round(v * 255)).join(',')})`;
  if (prev) Ink.drawSegment(wctx, prev, pt); else Ink.drawDot(wctx, pt);
}

function onDown(e) {
  if (state.cfg.penOnly && e.pointerType !== 'pen') return;
  if (e.button !== 0 && e.pointerType !== 'pen') return;
  try { wet.setPointerCapture(e.pointerId); } catch (_) {}
  state.m.pointerType = e.pointerType;
  state.m.tilt = [e.tiltX | 0, e.tiltY | 0];
  state.cur = new Ink.Stroke(state.cfg);
  state.m.strokes++;
  consume(e);
  state.m.pendingEventTs = e.timeStamp;
  e.preventDefault();
}

function onMove(e) {
  if (!state.cur) return;
  const t0 = performance.now();
  state.m.jsLat.push(t0 - e.timeStamp);
  state.m.pointerType = e.pointerType;

  if (state.cfg.coalesced && e.getCoalescedEvents) {
    const co = e.getCoalescedEvents();
    state.m.coalescedPerEvent.push(co.length || 1);
    if (co.length) { for (const c of co) consume(c); }
    else consume(e);
  } else {
    // Toggle this OFF to see exactly what a naive implementation looks like:
    // one sample per frame, ~60 Hz, visibly polygonal on fast curves.
    state.m.coalescedPerEvent.push(1);
    consume(e);
  }

  if (state.cfg.prediction && e.getPredictedEvents) {
    // Predicted points are visual only. They are NEVER committed to the stroke.
    const pr = e.getPredictedEvents();
    if (pr.length) {
      const snapshot = state.cur.last;
      wctx.save(); wctx.globalAlpha = 0.85;
      let a = snapshot;
      for (const q of pr.slice(0, 2)) {
        const [x, y] = localXY(q);
        const b = { x, y, w: state.cur.widthFor(q.pressure || 0.5) };
        Ink.drawSegment(wctx, a, b); a = b;
      }
      wctx.restore();
    }
  }

  state.m.pendingEventTs = e.timeStamp;
  e.preventDefault();
}

function onUp(e) {
  if (!state.cur) return;
  // Commit: the finished stroke moves from the cheap "wet" layer to the "dry"
  // layer, which is only ever redrawn on resize. This wet/dry split is the
  // single biggest structural win for latency.
  state.strokes.push(state.cur);
  Ink.drawStroke(dctx, state.cur);
  state.cur = null;
  clearWet();
  try { wet.releasePointerCapture(e.pointerId); } catch (_) {}
}

function attachPointerHandlers() {
  wet.replaceWith(wet.cloneNode(false));           // drop old listeners
  wet = $('wet'); wctx = makeCtx(wet);
  wctx.setTransform(1, 0, 0, 1, 0, 0); wctx.scale(state.dpr, state.dpr);

  wet.addEventListener('pointerdown', onDown);
  const moveEvt = (state.cfg.rawUpdate && 'onpointerrawupdate' in window)
    ? 'pointerrawupdate' : 'pointermove';
  wet.addEventListener(moveEvt, onMove);
  wet.addEventListener('pointerup', onUp);
  wet.addEventListener('pointercancel', onUp);
  wet.addEventListener('pointerleave', e => { if (state.cur) onUp(e); });
  wet.addEventListener('contextmenu', e => e.preventDefault());
  $('evtName').textContent = moveEvt;
}

/* ---- HUD render loop ------------------------------------------------------ */
function fmt(v, d = 1) { return Number.isFinite(v) ? v.toFixed(d) : '--'; }

function tick(ts) {
  state.m.onFrame(ts);
  const m = state.m, v = m.verdict();

  $('mSampleHz').textContent = m.sampleHz || '--';
  $('mCoalesced').textContent = fmt(m.coalescedPerEvent.mean, 1);
  $('mJsLat').textContent = fmt(m.jsLat.pct(0.5)) + ' / ' + fmt(m.jsLat.pct(0.95));
  $('mPaint50').textContent = fmt(m.paintLat.pct(0.5));
  $('mPaint95').textContent = fmt(m.paintLat.pct(0.95));
  $('mPaint99').textContent = fmt(m.paintLat.pct(0.99));
  $('mFps').textContent = m.frameGap.mean ? fmt(1000 / m.frameGap.mean, 0) : '--';
  $('mJitter').textContent = fmt(m.frameGap.std, 2);
  $('mLevels').textContent = m.levels.size;
  $('mMaxP').textContent = fmt(m.maxPressure, 3);
  $('mType').textContent = m.pointerType;
  $('mTilt').textContent = m.tilt ? `${m.tilt[0]}, ${m.tilt[1]}` : '--';
  $('mStrokes').textContent = m.strokes;
  $('mSamples').textContent = m.samples.toLocaleString();

  for (const [k, el] of [['sampleHz', 'gSample'], ['paintP95', 'gPaint'],
                         ['jitter', 'gJitter'], ['levels', 'gLevels'], ['pen', 'gPen']]) {
    const g = $(el);
    g.className = 'gate ' + (v[k].ok ? 'ok' : (m.samples > 60 ? 'bad' : 'idle'));
  }
  const gate = $('gateVerdict');
  if (m.samples < 200) {
    gate.className = 'verdict idle';
    gate.textContent = 'Scribble hard for ~20 seconds to collect data\u2026';
  } else if (v.pass) {
    gate.className = 'verdict pass';
    gate.textContent = 'M0 GATE: PASS \u2014 now confirm with a 240 fps camera';
  } else {
    gate.className = 'verdict fail';
    gate.textContent = 'M0 GATE: FAIL \u2014 see diagnostics';
  }

  const diag = HUD.diagnose(m);
  const box = $('diagnostics');
  if (!diag.length) {
    box.innerHTML = m.samples > 200
      ? '<div class="diag info">No problems detected.</div>' : '';
  } else {
    box.innerHTML = diag.map(([lvl, msg]) =>
      `<div class="diag ${lvl}">${msg}</div>`).join('');
  }
  requestAnimationFrame(tick);
}

/* ---- controls ------------------------------------------------------------- */
function bindControls() {
  const num = (id, key, fn) => {
    const el = $(id);
    el.addEventListener('input', () => {
      state.cfg[key] = parseFloat(el.value);
      $(id + 'Val').textContent = fn ? fn(el.value) : el.value;
    });
    $(id + 'Val').textContent = fn ? fn(el.value) : el.value;
  };
  num('cWidth', 'baseWidth');
  num('cGamma', 'gamma');
  num('cMinCutoff', 'minCutoff');
  num('cBeta', 'beta');

  const chk = (id, key, after) => {
    const el = $(id);
    el.checked = state.cfg[key];
    el.addEventListener('change', () => { state.cfg[key] = el.checked; after && after(); });
  };
  chk('cSmooth', 'smoothing');
  chk('cCoalesced', 'coalesced');
  chk('cRaw', 'rawUpdate', attachPointerHandlers);
  chk('cPredict', 'prediction');
  chk('cPenOnly', 'penOnly');
  chk('cDesync', 'desync', resize);

  $('cColor').addEventListener('input', e => {
    const h = e.target.value;
    state.cfg.rgb = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255);
  });

  $('btnClear').addEventListener('click', () => {
    state.strokes = []; state.cur = null; redrawDry(); clearWet();
  });
  $('btnReset').addEventListener('click', () => state.m.reset());
  $('btnExport').addEventListener('click', exportCapture);
  $('btnPanel').addEventListener('click', () =>
    document.body.classList.toggle('collapsed'));
}

/** Export in the exact schema poc_build.py consumes, so you can turn a real
 *  Huion capture into a real single-file PDF with no glue code. */
function exportCapture() {
  const payload = {
    format: 'inkwell-m0-capture/1',
    captured_at: new Date().toISOString(),
    device: {
      pointerType: state.m.pointerType,
      reported_hz: state.m.sampleHz,
      tilt: state.m.tilt,
      dpr: state.dpr,
      userAgent: navigator.userAgent,
    },
    metrics: {
      evt_to_paint_p50: state.m.paintLat.pct(0.5),
      evt_to_paint_p95: state.m.paintLat.pct(0.95),
      frame_jitter_ms: state.m.frameGap.std,
      pressure_levels: state.m.levels.size,
    },
    strokes: state.strokes.map(s => ({
      id: s.id, kind: s.kind, rgb: s.rgb,
      base_width: s.base_width, samples: s.samples,
    })),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'inkwell-capture.json';
  a.click();
}

/* ---- boot ----------------------------------------------------------------- */
window.addEventListener('DOMContentLoaded', () => {
  dry = $('dry'); wet = $('wet');
  resize();
  attachPointerHandlers();
  bindControls();

  if (window.self !== window.top) {
    $('embedWarning').style.display = 'block';
  }
  $('rawSupported').textContent =
    ('onpointerrawupdate' in window) ? 'available' : 'NOT available';

  window.addEventListener('resize', () => { clearTimeout(window._rt);
    window._rt = setTimeout(resize, 120); });
  requestAnimationFrame(tick);
});
