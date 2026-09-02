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
  constructor(minCutoff = 1.1, beta = 0.006, dCutoff = 1.0) {
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

// A light trailing spring removes digitizer tremor without trying to predict
// the pen. The first point is kept exact so a stroke never visibly starts late.
class Streamline {
  constructor(positionLerp = 0.45, pressureLerp = 0.35) {
    this.positionLerp = positionLerp;
    this.pressureLerp = pressureLerp;
    this.curX = null;
    this.curY = null;
    this.curP = null;
  }

  filter(x, y, p) {
    if (this.curX === null) {
      this.curX = x;
      this.curY = y;
      this.curP = p;
    } else {
      this.curX += (x - this.curX) * this.positionLerp;
      this.curY += (y - this.curY) * this.positionLerp;
      this.curP += (p - this.curP) * this.pressureLerp;
    }
    return { x: this.curX, y: this.curY, p: this.curP };
  }
}

function computeStrokeBbox(pts, baseWidth = 2.0) {
  if (!pts || !pts.length) return [0, 0, 0, 0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const halfW = (baseWidth || 2.0) / 2;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x = p.x !== undefined ? p.x : p[0];
    const y = p.y !== undefined ? p.y : p[1];
    const w = (p.w !== undefined ? p.w / 2 : halfW) || halfW;
    if (x - w < minX) minX = x - w;
    if (y - w < minY) minY = y - w;
    if (x + w > maxX) maxX = x + w;
    if (y + w > maxY) maxY = y + w;
  }
  return [minX, minY, maxX, maxY];
}

class Stroke {
  constructor(opts = {}) {
    this.id = crypto.randomUUID ? crypto.randomUUID()
                                : String(Math.random()).slice(2);
    this.kind = opts.kind || 'pen';
    this.rgb = opts.rgb || [0.08, 0.09, 0.14];
    this.base_width = opts.baseWidth || 3.0;
    this.cssColor = `rgb(${this.rgb.map(v => Math.round(v * 255)).join(',')})`;
    this.samples = [];
    this._pts = [];            // {x, y, w} in CSS px, post-filter
    const minCut = opts.minCutoff !== undefined ? opts.minCutoff : 1.1;
    const bCut = opts.beta !== undefined ? opts.beta : 0.006;
    this._fx = new OneEuro(minCut, bCut);
    this._fy = new OneEuro(minCut, bCut);
    this._p = null;
    this._gamma = opts.gamma || 1.0;
    this._smoothing = opts.smoothing !== false;
    this._warmup = 0;          // Huion reports garbage pressure on entry
    this._cachedPath2D = null;
    this.bbox = [Infinity, Infinity, -Infinity, -Infinity];
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

    const w = this.widthFor(this._p);
    const pt = { x: fx, y: fy, w, p: this._p, t: tMs };
    this._pts.push(pt);
    this.samples.push([fx, fy, this._p, tMs]);

    const r = w / 2;
    if (fx - r < this.bbox[0]) this.bbox[0] = fx - r;
    if (fy - r < this.bbox[1]) this.bbox[1] = fy - r;
    if (fx + r > this.bbox[2]) this.bbox[2] = fx + r;
    if (fy + r > this.bbox[3]) this.bbox[3] = fy + r;

    return pt;
  }

  getPath2D() {
    if (!this._cachedPath2D) {
      this._cachedPath2D = getPath2D(this);
    }
    return this._cachedPath2D;
  }

  get points() { return this._pts; }
  set points(val) { this._pts = val; }
  get last() { return this._pts[this._pts.length - 1]; }
}

function addDotToPath(path, p) {
  const w = (p && p.w !== undefined && !isNaN(p.w)) ? p.w : ((p && p.p !== undefined) ? p.p * 2.0 : 2.0);
  const r = Math.max(0.1, w / 2);
  path.moveTo(p.x + r, p.y);
  path.arc(p.x, p.y, r, 0, Math.PI * 2);
}

function addSegmentToPath(path, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1e-6;
  const nx = -dy / L, ny = dx / L;
  const wa = (a && a.w !== undefined && !isNaN(a.w)) ? a.w : ((a && a.p !== undefined) ? a.p * 2.0 : 2.0);
  const wb = (b && b.w !== undefined && !isNaN(b.w)) ? b.w : ((b && b.p !== undefined) ? b.p * 2.0 : 2.0);
  const ha = Math.max(0.05, wa / 2), hb = Math.max(0.05, wb / 2);
  path.moveTo(a.x + nx * ha, a.y + ny * ha);
  path.lineTo(b.x + nx * hb, b.y + ny * hb);
  path.lineTo(b.x - nx * hb, b.y - ny * hb);
  path.lineTo(a.x - nx * ha, a.y - ny * ha);
  path.closePath();
  path.moveTo(b.x + hb, b.y);
  path.arc(b.x, b.y, hb, 0, Math.PI * 2);
}

function getChiselPath2D(rawPts, baseH = 16.0) {
  if (typeof Path2D === 'undefined' || !rawPts || !rawPts.length) return null;
  const path = new Path2D();
  const halfH = (baseH || 16.0) / 2;
  // 45-degree chisel normal vector
  const nx = 0.70710678 * halfH;
  const ny = 0.70710678 * halfH;

  if (rawPts.length === 1) {
    const p = rawPts[0];
    path.moveTo(p.x - nx, p.y - ny);
    path.lineTo(p.x + nx, p.y + ny);
    path.lineTo(p.x + nx + 2, p.y + ny);
    path.lineTo(p.x - nx + 2, p.y - ny);
    path.closePath();
    return path;
  }

  const pts = chaikinSubdivide(rawPts, 1);
  if (pts.length < 2) return null;

  // Upper chisel contour
  path.moveTo(pts[0].x - nx, pts[0].y - ny);
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1].x + pts[i].x) / 2 - nx;
    const my = (pts[i - 1].y + pts[i].y) / 2 - ny;
    path.quadraticCurveTo(pts[i - 1].x - nx, pts[i - 1].y - ny, mx, my);
  }
  const last = pts[pts.length - 1];
  path.lineTo(last.x - nx, last.y - ny);

  // Chisel end cap
  path.lineTo(last.x + nx, last.y + ny);

  // Lower chisel contour
  for (let i = pts.length - 1; i > 0; i--) {
    const mx = (pts[i].x + pts[i - 1].x) / 2 + nx;
    const my = (pts[i].y + pts[i - 1].y) / 2 + ny;
    path.quadraticCurveTo(pts[i].x + nx, pts[i].y + ny, mx, my);
  }
  path.lineTo(pts[0].x + nx, pts[0].y + ny);

  // Chisel start cap
  path.closePath();
  return path;
}

function getPath2D(stroke) {
  if (typeof Path2D === 'undefined') return null;
  const rawPts = stroke.points || stroke._pts;
  if (!rawPts || !rawPts.length) return null;

  if (stroke.kind === 'highlighter') {
    return getChiselPath2D(rawPts, stroke.base_width || stroke.baseWidth || 16.0);
  }

  const path = new Path2D();
  if (rawPts.length === 1) {
    addDotToPath(path, rawPts[0]);
    return path;
  }
  if (rawPts.length === 2) {
    addDotToPath(path, rawPts[0]);
    addSegmentToPath(path, rawPts[0], rawPts[1]);
    return path;
  }

  const points = chaikinSubdivide(rawPts);
  let pPrev = points[0];
  addDotToPath(path, pPrev);

  for (let i = 1; i < points.length - 1; i++) {
    const start = pPrev;
    const prevW = (points[i].w !== undefined && !isNaN(points[i].w)) ? points[i].w : 2.0;
    const nextW = (points[i + 1].w !== undefined && !isNaN(points[i + 1].w)) ? points[i + 1].w : 2.0;
    const end = {
      x: (points[i].x + points[i + 1].x) / 2,
      y: (points[i].y + points[i + 1].y) / 2,
      w: (prevW + nextW) / 2,
    };
    const steps = 3;
    for (let s = 1; s <= steps; s++) {
      const pCurr = quadraticAt(start, points[i], end, s / steps);
      addSegmentToPath(path, pPrev, pCurr);
      pPrev = pCurr;
    }
  }
  const last = points[points.length - 1];
  const start = pPrev;
  for (let s = 1; s <= 3; s++) {
    const pCurr = quadraticAt(start, points[points.length - 2], last, s / 3);
    addSegmentToPath(path, pPrev, pCurr);
    pPrev = pCurr;
  }

  return path;
}

function drawSegment(ctx, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1e-6;
  const nx = -dy / L, ny = dx / L;
  const wa = (a && a.w !== undefined && !isNaN(a.w)) ? a.w : ((a && a.p !== undefined) ? a.p * 2.0 : 2.0);
  const wb = (b && b.w !== undefined && !isNaN(b.w)) ? b.w : ((b && b.p !== undefined) ? b.p * 2.0 : 2.0);
  const ha = Math.max(0.05, wa / 2), hb = Math.max(0.05, wb / 2);
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
  const w = (p && p.w !== undefined && !isNaN(p.w)) ? p.w : ((p && p.p !== undefined) ? p.p * 2.0 : 2.0);
  const r = Math.max(0.1, w / 2);
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function openPolylineToCubics(p) {
  const n = p.length;
  if (n < 2) return [];
  if (n === 2) {
    const a = p[0], b = p[1];
    const wa = (a && a.w !== undefined) ? a.w : 2.0;
    const wb = (b && b.w !== undefined) ? b.w : 2.0;
    const dx = b.x - a.x, dy = b.y - a.y, dw = wb - wa;
    return [[
      { x: a.x + dx / 3, y: a.y + dy / 3, w: wa + dw / 3 },
      { x: a.x + 2 * dx / 3, y: a.y + 2 * dy / 3, w: wa + 2 * dw / 3 },
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
    const prevW = p[i - 1].w !== undefined ? p[i - 1].w : 2.0;
    const nextW = p[i + 1].w !== undefined ? p[i + 1].w : 2.0;
    m[i] = {
      x: (p[i + 1].x - p[i - 1].x) / dt,
      y: (p[i + 1].y - p[i - 1].y) / dt,
      w: (nextW - prevW) / dt,
    };
  }

  const dt0 = t[1] - t[0], dt1 = (n > 2) ? (t[2] - t[1]) : dt0;
  const p0w = p[0].w !== undefined ? p[0].w : 2.0;
  const p1w = p[1].w !== undefined ? p[1].w : 2.0;
  const p2w = (p[2] && p[2].w !== undefined) ? p[2].w : p1w;
  m[0] = {
    x: ((2 * dt0 + dt1) * (p[1].x - p[0].x) / dt0 - dt0 * ((p[2] ? p[2].x : p[1].x) - p[1].x) / Math.max(1e-4, dt1)) / Math.max(1e-4, dt0 + dt1),
    y: ((2 * dt0 + dt1) * (p[1].y - p[0].y) / dt0 - dt0 * ((p[2] ? p[2].y : p[1].y) - p[1].y) / Math.max(1e-4, dt1)) / Math.max(1e-4, dt0 + dt1),
    w: ((2 * dt0 + dt1) * (p1w - p0w) / dt0 - dt0 * (p2w - p1w) / Math.max(1e-4, dt1)) / Math.max(1e-4, dt0 + dt1),
  };

  const dtn2 = t[n - 1] - t[n - 2];
  const dtn3 = (n > 2) ? (t[n - 2] - t[n - 3]) : dtn2;
  const pPrev2 = p[n - 3] || p[n - 2];
  const pn1w = p[n - 1].w !== undefined ? p[n - 1].w : 2.0;
  const pn2w = p[n - 2].w !== undefined ? p[n - 2].w : 2.0;
  const prev2w = (pPrev2 && pPrev2.w !== undefined) ? pPrev2.w : pn2w;
  m[n - 1] = {
    x: ((2 * dtn2 + dtn3) * (p[n - 1].x - p[n - 2].x) / dtn2 - dtn2 * (p[n - 2].x - pPrev2.x) / Math.max(1e-4, dtn3)) / Math.max(1e-4, dtn2 + dtn3),
    y: ((2 * dtn2 + dtn3) * (p[n - 1].y - p[n - 2].y) / dtn2 - dtn2 * (p[n - 2].y - pPrev2.y) / Math.max(1e-4, dtn3)) / Math.max(1e-4, dtn2 + dtn3),
    w: ((2 * dtn2 + dtn3) * (pn1w - pn2w) / dtn2 - dtn2 * (pn2w - prev2w) / Math.max(1e-4, dtn3)) / Math.max(1e-4, dtn2 + dtn3),
  };

  const cubics = [];
  for (let i = 0; i < n - 1; i++) {
    const dt = t[i + 1] - t[i];
    const pw = p[i].w !== undefined ? p[i].w : 2.0;
    const c1 = {
      x: p[i].x + (m[i].x * dt) / 3,
      y: p[i].y + (m[i].y * dt) / 3,
      w: pw + (m[i].w * dt) / 3,
    };
    const c2 = {
      x: p[i + 1].x - (m[i + 1].x * dt) / 3,
      y: p[i + 1].y - (m[i + 1].y * dt) / 3,
      w: (p[i + 1].w !== undefined ? p[i + 1].w : 2.0) - (m[i + 1].w * dt) / 3,
    };
    cubics.push([c1, c2, p[i + 1]]);
  }
  return cubics;
}

function cubicAt(p0, cubic, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  const w0 = p0.w !== undefined ? p0.w : 2.0;
  const w1 = (cubic[0] && cubic[0].w !== undefined) ? cubic[0].w : 2.0;
  const w2 = (cubic[1] && cubic[1].w !== undefined) ? cubic[1].w : 2.0;
  const w3 = (cubic[2] && cubic[2].w !== undefined) ? cubic[2].w : 2.0;
  return {
    x: a * p0.x + b * cubic[0].x + c * cubic[1].x + d * cubic[2].x,
    y: a * p0.y + b * cubic[0].y + c * cubic[1].y + d * cubic[2].y,
    w: a * w0 + b * w1 + c * w2 + d * w3,
  };
}

function chaikinSubdivide(points, iterations = 2) {
  let out = points.slice();
  for (let pass = 0; pass < iterations && out.length > 2; pass++) {
    const next = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      const wa = (a && a.w !== undefined && !isNaN(a.w)) ? a.w : ((a && a.p !== undefined) ? a.p * 2.0 : 2.0);
      const wb = (b && b.w !== undefined && !isNaN(b.w)) ? b.w : ((b && b.p !== undefined) ? b.p * 2.0 : 2.0);
      next.push({
        x: 0.75 * a.x + 0.25 * b.x,
        y: 0.75 * a.y + 0.25 * b.y,
        w: 0.75 * wa + 0.25 * wb,
      });
      next.push({
        x: 0.25 * a.x + 0.75 * b.x,
        y: 0.25 * a.y + 0.75 * b.y,
        w: 0.25 * wa + 0.75 * wb,
      });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

function quadraticAt(p0, control, p1, t) {
  const u = 1 - t;
  const w0 = (p0 && p0.w !== undefined && !isNaN(p0.w)) ? p0.w : 2.0;
  const wc = (control && control.w !== undefined && !isNaN(control.w)) ? control.w : 2.0;
  const w1 = (p1 && p1.w !== undefined && !isNaN(p1.w)) ? p1.w : 2.0;
  return {
    x: u * u * p0.x + 2 * u * t * control.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * control.y + t * t * p1.y,
    w: u * u * w0 + 2 * u * t * wc + t * t * w1,
  };
}

function drawStroke(ctx, stroke) {
  const rawPts = stroke.points || stroke._pts;
  if (!rawPts || !rawPts.length) return;

  const isHighlighter = stroke.kind === 'highlighter';
  if (isHighlighter) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.42;
  }

  ctx.fillStyle = stroke.cssColor || `rgb(${stroke.rgb.map(v => Math.round(v * 255)).join(',')})`;

  if (!stroke._cachedPath2D && typeof Path2D !== 'undefined') {
    stroke._cachedPath2D = getPath2D(stroke);
  }

  if (stroke._cachedPath2D) {
    ctx.fill(stroke._cachedPath2D);
    if (isHighlighter) ctx.restore();
    return;
  }

  if (isHighlighter) {
    const p2d = getChiselPath2D(rawPts, stroke.base_width || stroke.baseWidth || 16.0);
    if (p2d) ctx.fill(p2d);
    ctx.restore();
    return;
  }

  if (rawPts.length === 1) {
    drawDot(ctx, rawPts[0]);
    if (isHighlighter) ctx.restore();
    return;
  }
  if (rawPts.length === 2) {
    drawDot(ctx, rawPts[0]);
    drawSegment(ctx, rawPts[0], rawPts[1]);
    if (isHighlighter) ctx.restore();
    return;
  }

  const points = chaikinSubdivide(rawPts);
  let pPrev = points[0];
  drawDot(ctx, pPrev);

  // Midpoint quadratics are C1-continuous; sampling them into the existing
  // variable-width ribbon preserves the pressure taper of the input stroke.
  for (let i = 1; i < points.length - 1; i++) {
    const start = pPrev;
    const end = {
      x: (points[i].x + points[i + 1].x) / 2,
      y: (points[i].y + points[i + 1].y) / 2,
      w: (points[i].w + points[i + 1].w) / 2,
    };
    const steps = 3;
    for (let s = 1; s <= steps; s++) {
      const pCurr = quadraticAt(start, points[i], end, s / steps);
      drawSegment(ctx, pPrev, pCurr);
      pPrev = pCurr;
    }
  }
  const last = points[points.length - 1];
  const start = pPrev;
  for (let s = 1; s <= 3; s++) {
    const pCurr = quadraticAt(start, points[points.length - 2], last, s / 3);
    drawSegment(ctx, pPrev, pCurr);
    pPrev = pCurr;
  }

  if (isHighlighter) ctx.restore();
}

window.Ink = { OneEuro, Streamline, Stroke, drawSegment, drawDot, drawStroke, openPolylineToCubics, cubicAt, chaikinSubdivide, quadraticAt, getPath2D, getChiselPath2D, computeStrokeBbox };

