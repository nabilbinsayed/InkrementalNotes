/* ============================================================================
 * ink.js — the ink engine.
 * Deliberately dependency-free and framework-free.
 * Ported verbatim from inkwell-m0 for complete latency & maths preservation.
 * ========================================================================== */

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
  constructor(minCutoff = 0.8, beta = 0.004, dCutoff = 1.0) {
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

class Stroke {
  constructor(opts = {}) {
    this.id = crypto.randomUUID ? crypto.randomUUID()
                                : String(Math.random()).slice(2);
    this.kind = opts.kind || 'pen';
    this.rgb = opts.rgb || [0.08, 0.09, 0.14];
    this.base_width = opts.baseWidth || 3.2;
    this.samples = [];
    this._pts = [];            // {x, y, w} in CSS px, post-filter
    const minCut = opts.minCutoff !== undefined ? opts.minCutoff : 0.8;
    const bCut = opts.beta !== undefined ? opts.beta : 0.004;
    this._fx = new OneEuro(minCut, bCut);
    this._fy = new OneEuro(minCut, bCut);
    this._p = null;
    this._gamma = opts.gamma || 1.0;
    this._smoothing = opts.smoothing !== false;
    this._warmup = 0;          // Huion reports garbage pressure on entry
  }

  widthFor(p) {
    const c = Math.pow(Math.max(0, Math.min(1, p)), this._gamma);
    return this.base_width * (0.22 + 0.78 * c);
  }

  push(x, y, pressure, tMs) {
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

function openPolylineToCubics(p) {
  const n = p.length;
  if (n < 2) return [];
  if (n === 2) {
    const a = p[0], b = p[1];
    const dx = b.x - a.x, dy = b.y - a.y, dw = b.w - a.w;
    return [[
      { x: a.x + dx / 3, y: a.y + dy / 3, w: a.w + dw / 3 },
      { x: a.x + 2 * dx / 3, y: a.y + 2 * dy / 3, w: a.w + 2 * dw / 3 },
      b
    ]];
  }

  const t = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dist = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    t[i] = t[i - 1] + Math.max(1e-4, Math.sqrt(dist));
  }

  const m = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    const dt = t[i + 1] - t[i - 1];
    m[i] = {
      x: (p[i + 1].x - p[i - 1].x) / dt,
      y: (p[i + 1].y - p[i - 1].y) / dt,
      w: (p[i + 1].w - p[i - 1].w) / dt,
    };
  }

  const dt0 = t[1] - t[0], dt1 = (n > 2) ? (t[2] - t[1]) : dt0;
  m[0] = {
    x: ((2 * dt0 + dt1) * (p[1].x - p[0].x) / dt0 - dt0 * ((p[2] ? p[2].x : p[1].x) - p[1].x) / Math.max(1e-4, dt1)) / Math.max(1e-4, dt0 + dt1),
    y: ((2 * dt0 + dt1) * (p[1].y - p[0].y) / dt0 - dt0 * ((p[2] ? p[2].y : p[1].y) - p[1].y) / Math.max(1e-4, dt1)) / Math.max(1e-4, dt0 + dt1),
    w: ((2 * dt0 + dt1) * (p[1].w - p[0].w) / dt0 - dt0 * ((p[2] ? p[2].w : p[1].w) - p[1].w) / Math.max(1e-4, dt1)) / Math.max(1e-4, dt0 + dt1),
  };

  const dtn2 = t[n - 1] - t[n - 2];
  const dtn3 = (n > 2) ? (t[n - 2] - t[n - 3]) : dtn2;
  const pPrev2 = p[n - 3] || p[n - 2];
  m[n - 1] = {
    x: ((2 * dtn2 + dtn3) * (p[n - 1].x - p[n - 2].x) / dtn2 - dtn2 * (p[n - 2].x - pPrev2.x) / Math.max(1e-4, dtn3)) / Math.max(1e-4, dtn2 + dtn3),
    y: ((2 * dtn2 + dtn3) * (p[n - 1].y - p[n - 2].y) / dtn2 - dtn2 * (p[n - 2].y - pPrev2.y) / Math.max(1e-4, dtn3)) / Math.max(1e-4, dtn2 + dtn3),
    w: ((2 * dtn2 + dtn3) * (p[n - 1].w - p[n - 2].w) / dtn2 - dtn2 * (p[n - 2].w - pPrev2.w) / Math.max(1e-4, dtn3)) / Math.max(1e-4, dtn2 + dtn3),
  };

  const cubics = [];
  for (let i = 0; i < n - 1; i++) {
    const dt = t[i + 1] - t[i];
    const c1 = {
      x: p[i].x + (m[i].x * dt) / 3,
      y: p[i].y + (m[i].y * dt) / 3,
      w: p[i].w + (m[i].w * dt) / 3,
    };
    const c2 = {
      x: p[i + 1].x - (m[i + 1].x * dt) / 3,
      y: p[i + 1].y - (m[i + 1].y * dt) / 3,
      w: p[i + 1].w - (m[i + 1].w * dt) / 3,
    };
    cubics.push([c1, c2, p[i + 1]]);
  }
  return cubics;
}

function cubicAt(p0, cubic, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * cubic[0].x + c * cubic[1].x + d * cubic[2].x,
    y: a * p0.y + b * cubic[0].y + c * cubic[1].y + d * cubic[2].y,
    w: a * p0.w + b * cubic[0].w + c * cubic[1].w + d * cubic[2].w,
  };
}

function drawStroke(ctx, stroke) {
  const rawPts = stroke.points;
  if (!rawPts || !rawPts.length) return;
  ctx.fillStyle = `rgb(${stroke.rgb.map(v => Math.round(v * 255)).join(',')})`;
  if (rawPts.length === 1) { drawDot(ctx, rawPts[0]); return; }
  if (rawPts.length === 2) { drawDot(ctx, rawPts[0]); drawSegment(ctx, rawPts[0], rawPts[1]); return; }

  const cubics = openPolylineToCubics(rawPts);
  let pPrev = rawPts[0];
  drawDot(ctx, pPrev);

  for (let i = 0; i < cubics.length; i++) {
    const c = cubics[i];
    const steps = 6;
    for (let s = 1; s <= steps; s++) {
      const pCurr = cubicAt(pPrev, c, s / steps);
      drawSegment(ctx, pPrev, pCurr);
      pPrev = pCurr;
    }
  }
}

window.Ink = { OneEuro, Stroke, drawSegment, drawDot, drawStroke, openPolylineToCubics, cubicAt };
