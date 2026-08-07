/* ============================================================================
 * hud.js — measurement. The whole point of M0.
 *
 * WHAT THIS CAN MEASURE (from JS):
 *   evt->js     : OS timestamped the event -> our handler ran
 *   evt->paint  : OS timestamped the event -> the frame that drew it began
 *   sample rate : true device Hz, via getCoalescedEvents()
 *   frame jitter: stddev of frame intervals (stutter is worse than latency)
 *
 * WHAT IT CANNOT MEASURE:
 *   compositor + display scanout + LCD response ~ 8-20 ms on a 60 Hz panel.
 *   For ground truth, film the screen and pen tip at 240 fps (4.17 ms/frame)
 *   and count frames. Nothing in software substitutes for this.
 * ========================================================================== */

const THRESHOLDS = {
  sampleHz:   { min: 150,  ideal: 233, label: 'Sample rate',   unit: 'Hz' },
  paintP95:   { max: 25,   ideal: 16,  label: 'evt->paint p95', unit: 'ms' },
  jitter:     { max: 3.0,  ideal: 1.0, label: 'Frame jitter',  unit: 'ms' },
  levels:     { min: 200,  ideal: 512, label: 'Pressure levels', unit: '' },
};

class Ring {
  constructor(n) { this.n = n; this.a = []; }
  push(v) { this.a.push(v); if (this.a.length > this.n) this.a.shift(); }
  get len() { return this.a.length; }
  pct(q) {
    if (!this.a.length) return 0;
    const s = [...this.a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  }
  get mean() { return this.a.length ? this.a.reduce((x, y) => x + y, 0) / this.a.length : 0; }
  get std() {
    if (this.a.length < 2) return 0;
    const m = this.mean;
    return Math.sqrt(this.a.reduce((s, v) => s + (v - m) ** 2, 0) / this.a.length);
  }
  clear() { this.a = []; }
}

class Metrics {
  constructor() {
    this.jsLat = new Ring(600);
    this.paintLat = new Ring(600);
    this.frameGap = new Ring(240);
    this.levels = new Set();
    this.pointerType = '--';
    this.tilt = null;
    this.samples = 0;
    this.strokes = 0;
    this._sampleWindow = [];      // timestamps for Hz calculation
    this._lastFrame = null;
    this.coalescedPerEvent = new Ring(120);
    this.maxPressure = 0;
    this.pendingEventTs = null;   // newest event ts drawn but not yet painted
  }

  onSample(tsMs, pressure) {
    this.samples++;
    this._sampleWindow.push(tsMs);
    const cut = tsMs - 1000;
    while (this._sampleWindow.length && this._sampleWindow[0] < cut) this._sampleWindow.shift();
    this.levels.add(Math.round(pressure * 1024));
    if (pressure > this.maxPressure) this.maxPressure = pressure;
  }

  get sampleHz() { return this._sampleWindow.length; }

  onFrame(rafTs) {
    if (this._lastFrame !== null) this.frameGap.push(rafTs - this._lastFrame);
    this._lastFrame = rafTs;
    if (this.pendingEventTs !== null) {
      this.paintLat.push(Math.max(0, rafTs - this.pendingEventTs));
      this.pendingEventTs = null;
    }
  }

  reset() {
    this.jsLat.clear(); this.paintLat.clear(); this.frameGap.clear();
    this.levels.clear(); this.samples = 0; this.strokes = 0;
    this.coalescedPerEvent.clear(); this.maxPressure = 0;
    this._sampleWindow = []; this._lastFrame = null;
  }

  verdict() {
    const v = {};
    v.sampleHz = { val: this.sampleHz, ok: this.sampleHz >= THRESHOLDS.sampleHz.min };
    const p95 = this.paintLat.pct(0.95);
    v.paintP95 = { val: p95, ok: p95 > 0 && p95 <= THRESHOLDS.paintP95.max };
    const j = this.frameGap.std;
    v.jitter = { val: j, ok: this.frameGap.len > 30 && j <= THRESHOLDS.jitter.max };
    v.levels = { val: this.levels.size, ok: this.levels.size >= THRESHOLDS.levels.min };
    v.pen = { val: this.pointerType, ok: this.pointerType === 'pen' };
    v.pass = Object.values(v).every(x => x.ok !== false);
    return v;
  }
}

/* ---- diagnostics: translate bad numbers into the actual fix --------------- */
function diagnose(m) {
  const out = [];
  if (m.samples > 40 && m.pointerType === 'mouse') {
    out.push(['error',
      'Your tablet is reporting as a MOUSE, not a pen. Open the Huion driver and ' +
      'turn Windows Ink ON. Without it you get no pressure and 60 Hz sampling.']);
  }
  if (m.samples > 200 && m.levels.size < 20) {
    out.push(['error',
      'Pressure is effectively constant (' + m.levels.size + ' distinct values). ' +
      'The pen is being treated as a digital on/off switch. Check the driver, and ' +
      'check that the pen nib is not worn flat.']);
  }
  if (m.samples > 200 && m.sampleHz > 0 && m.sampleHz < 100) {
    out.push(['warn',
      'Only ' + m.sampleHz + ' samples/sec. The H640P reports at 233 Hz, so ~' +
      Math.round(100 - m.sampleHz / 233 * 100) + '% of your pen data is being thrown away. ' +
      'This is what makes fast curves look polygonal. Make sure "Coalesced events" ' +
      'is ON below \u2014 turning it off shows you exactly what OpenBoard does wrong.']);
  }
  if (m.frameGap.len > 60 && m.frameGap.std > 4) {
    out.push(['warn',
      'Frame pacing is unstable (\u00b1' + m.frameGap.std.toFixed(1) + ' ms). Inconsistent ' +
      'latency reads as "laggy" far more than constant latency does. Close other GPU ' +
      'apps, plug in the laptop, and set the power plan to High Performance.']);
  }
  if (m.paintLat.len > 60 && m.paintLat.pct(0.95) > 40) {
    out.push(['warn',
      'evt->paint p95 is ' + m.paintLat.pct(0.95).toFixed(0) + ' ms. Something is ' +
      'blocking the main thread. In the real app this is why input must live on its ' +
      'own thread, away from PDF decoding and autosave.']);
  }
  if (m.tilt && (m.tilt[0] !== 0 || m.tilt[1] !== 0)) {
    out.push(['info', 'This device reports tilt \u2014 unexpected for an H640P.']);
  }
  return out;
}

window.HUD = { Metrics, THRESHOLDS, diagnose };
