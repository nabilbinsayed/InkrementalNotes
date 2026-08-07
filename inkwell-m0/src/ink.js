/* ============================================================================
 * ink.js — the ink engine.
 * Deliberately dependency-free and framework-free. This is the part you should
 * understand line-by-line; everything else in the app is replaceable.
 * ========================================================================== */

/* ---- One-Euro filter -------------------------------------------------------
 * Adaptive low-pass: heavy smoothing when the pen is slow (kills tremor),
 * light smoothing when it's fast (kills lag). Strictly better than a fixed EMA.
 * Ref: Casiez, Roussel, Vogel — CHI 2012.
 * -------------------------------------------------------------------------- */
class LowPass {
  constructor() { this.y = null; this.s = null; }
  filter(x, a) {
    this.s = this.s === null ? x : a * x + (1 - a) * this.s;
    this.y = x;
    return this.s;
  }
  get hasLast() { return this.s !== null; }
}

class OneEuro {
  constructor(minCutoff = 1.7, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = new LowPass(); this.dx = new LowPass(); this.tPrev = null;
  }
  _alpha(cutoff, dt) { const te = 1 / (2 * Math.PI * cutoff); return 1 / (1 + te / dt); }
  reset() { this.x = new LowPass(); this.dx = new LowPass(); this.tPrev = null; }
  filter(v, tMs) {
    const t = tMs / 1000;
    const dt = this.tPrev === null ? 1 / 233 : Math.max(1e-4, t - this.tPrev);
    this.tPrev = t;
    const dv = this.x.hasLast ? (v - this.x.s) / dt : 0;
    const edv = this.dx.filter(dv, this._alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edv);
    return this.x.filter(v, this._alpha(cutoff, dt));
  }
}

/* ---- Stroke ---------------------------------------------------------------
 * samples are [x, y, pressure, tMs] — the exact schema the PDF writer expects,
 * so a capture from this app drops straight into the single-PDF proof.
 * -------------------------------------------------------------------------- */
class Stroke {
  constructor(opts) {
    this.id = crypto.randomUUID ? crypto.randomUUID()
                                : String(Math.random()).slice(2);
    this.kind = 'pen';
    this.rgb = opts.rgb;
    this.base_width = opts.baseWidth;
    this.samples = [];
    this._pts = [];            // {x, y, w} in CSS px, post-filter
    this._fx = new OneEuro(opts.minCutoff, opts.beta);
    this._fy = new OneEuro(opts.minCutoff, opts.beta);
    this._p = null;
    this._gamma = opts.gamma;
    this._smoothing = opts.smoothing;
    this._warmup = 0;          // Huion reports garbage pressure on entry
  }

  widthFor(p) {
    const c = Math.pow(Math.max(0, Math.min(1, p)), this._gamma);
    return this.base_width * (0.22 + 0.78 * c);
  }

  /** Push one raw device sample. Returns the new point, or null if rejected. */
  push(x, y, pressure, tMs) {
    // Huion H640P (and most EMR tablets) emit 1-2 junk pressure values on
    // pen-down. Backfill them from the third sample instead of drawing a blob.
    this._warmup++;
    let p = pressure;
    if (this._warmup <= 2) p = Math.min(p, 0.35);

    const fx = this._smoothing ? this._fx.filter(x, tMs) : x;
    const fy = this._smoothing ? this._fy.filter(y, tMs) : y;
    this._p = this._p === null ? p : this._p + 0.35 * (p - this._p);   // EMA on pressure

    const last = this._pts[this._pts.length - 1];
    if (last && Math.hypot(fx - last.x, fy - last.y) < 0.05) return null; // dedup

    const pt = { x: fx, y: fy, w: this.widthFor(this._p) };
    this._pts.push(pt);
    this.samples.push([+fx.toFixed(3), +fy.toFixed(3), +this._p.toFixed(4), +tMs.toFixed(1)]);
    return pt;
  }

  get points() { return this._pts; }
  get last() { return this._pts[this._pts.length - 1]; }
}

/* ---- Rendering ------------------------------------------------------------
 * Variable-width ink = a filled ribbon, NOT a stroked line. A stroked line has
 * one constant width, so pressure is impossible with it. Same maths is reused
 * verbatim when exporting to PDF, so screen and file always agree.
 * -------------------------------------------------------------------------- */
function drawSegment(ctx, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1e-6;
  const nx = -dy / L, ny = dx / L;
  const ha = a.w / 2, hb = b.w / 2;
  ctx.beginPath();
  ctx.moveTo(a.x + nx * ha, a.y + ny * ha);
  ctx.lineTo(b.x + nx * hb, b.y + ny * hb);
  ctx.lineTo(b.x - nx * hb, b.y - ny * hb);
  ctx.lineTo(a.x - nx * ha, a.y - ny * ha);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();                      // round join / cap
  ctx.arc(b.x, b.y, hb, 0, Math.PI * 2);
  ctx.fill();
}

function drawDot(ctx, p) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawStroke(ctx, stroke) {
  const pts = stroke.points;
  if (!pts.length) return;
  ctx.fillStyle = `rgb(${stroke.rgb.map(v => Math.round(v * 255)).join(',')})`;
  if (pts.length === 1) { drawDot(ctx, pts[0]); return; }
  drawDot(ctx, pts[0]);
  for (let i = 1; i < pts.length; i++) drawSegment(ctx, pts[i - 1], pts[i]);
}

window.Ink = { OneEuro, Stroke, drawSegment, drawDot, drawStroke };
