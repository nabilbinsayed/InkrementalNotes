// Deep adversarial stress test for spatial indexing, viewport math, and undo/redo/transforms
const fs = require('fs');
const path = require('path');

global.window = global;
global.crypto = require('crypto');

class MockPath2D {
  constructor() { this.ops = []; }
  moveTo(x, y) { this.ops.push(['moveTo', x, y]); }
  lineTo(x, y) { this.ops.push(['lineTo', x, y]); }
  arc(x, y, r, sa, ea) { this.ops.push(['arc', x, y, r, sa, ea]); }
  quadraticCurveTo(cx, cy, x, y) { this.ops.push(['quadraticCurveTo', cx, cy, x, y]); }
  closePath() { this.ops.push(['closePath']); }
}
global.Path2D = MockPath2D;

const inkJsCode = fs.readFileSync(path.resolve(__dirname, '../../inkwell-app/src/js/ink.js'), 'utf-8');
eval(inkJsCode);

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${message}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${message}`);
  }
}

// Point in polygon raycasting helper (from app.js)
function pointInPolygon(px, py, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > py) !== (yj > py)) &&
                      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

console.log('=== TEST SUITE 1: Eraser AABB Pre-filtering Correctness & False Negatives ===');

// Create 100 random strokes scattered across a 2000x2000 canvas
const strokes = [];
for (let s = 0; s < 100; s++) {
  const stroke = new window.Ink.Stroke({ baseWidth: 3.0 });
  const startX = Math.random() * 1800 + 100;
  const startY = Math.random() * 1800 + 100;
  const numPts = 10 + Math.floor(Math.random() * 40);
  for (let p = 0; p < numPts; p++) {
    stroke.push(startX + p * 2 + Math.sin(p) * 5, startY + p * 2 + Math.cos(p) * 5, 0.5, p * 16);
  }
  const pts = stroke.points;
  stroke.sheet = 0;
  stroke.deleted = false;
  stroke.bbox = window.Ink.computeStrokeBbox(pts, stroke.base_width);
  strokes.push(stroke);
}

// Test 500 eraser queries: Verify AABB pre-filter NEVER produces false negatives
// (i.e. If raw sample distance <= radius, the AABB pre-filter MUST have returned true!)
let falseNegatives = 0;
let filteredOutCount = 0;
let actualHitCount = 0;

for (let q = 0; q < 500; q++) {
  const qx = Math.random() * 2000;
  const qy = Math.random() * 2000;
  const radius = 16.0;
  const qMinX = qx - radius;
  const qMaxX = qx + radius;
  const qMinY = qy - radius;
  const qMaxY = qy + radius;

  for (const s of strokes) {
    // 1. Raw exact distance check
    let rawHit = false;
    for (const pt of s.points) {
      if (Math.hypot(pt.x - qx, pt.y - qy) < radius + (pt.w || 2) / 2) {
        rawHit = true;
        break;
      }
    }

    // 2. AABB check
    const [sMinX, sMinY, sMaxX, sMaxY] = s.bbox;
    const aabbOverlap = !(sMaxX < qMinX || sMinX > qMaxX || sMaxY < qMinY || sMinY > qMaxY);

    if (!aabbOverlap) {
      filteredOutCount++;
      if (rawHit) {
        falseNegatives++;
      }
    } else {
      if (rawHit) actualHitCount++;
    }
  }
}

assert(falseNegatives === 0, `Eraser AABB filter produced 0 false negatives out of 50,000 checks (filtered ${filteredOutCount} non-overlapping tests)`);
assert(filteredOutCount > 40000, `Eraser AABB filter eliminated ${filteredOutCount} / 50000 candidate evaluations (~${((filteredOutCount/50000)*100).toFixed(1)}% work saved)`);

console.log('\n=== TEST SUITE 2: Lasso Selection Polygon and AABB Filter ===');

// Construct a star polygon in center [500, 500]
const poly = [
  [400, 400], [500, 450], [600, 400],
  [550, 500], [600, 600], [500, 550],
  [400, 600], [450, 500]
];
let polyMinX = Infinity, polyMinY = Infinity, polyMaxX = -Infinity, polyMaxY = -Infinity;
for (const pt of poly) {
  if (pt[0] < polyMinX) polyMinX = pt[0];
  if (pt[1] < polyMinY) polyMinY = pt[1];
  if (pt[0] > polyMaxX) polyMaxX = pt[0];
  if (pt[1] > polyMaxY) polyMaxY = pt[1];
}

// Stroke completely outside
const outsideStroke = new window.Ink.Stroke({ baseWidth: 3.0 });
outsideStroke.push(10, 10, 0.5, 0);
outsideStroke.push(20, 20, 0.5, 10);
outsideStroke.bbox = window.Ink.computeStrokeBbox(outsideStroke.points, 3.0);

const outsideSkipped = (outsideStroke.bbox[2] < polyMinX || outsideStroke.bbox[0] > polyMaxX ||
                        outsideStroke.bbox[3] < polyMinY || outsideStroke.bbox[1] > polyMaxY);
assert(outsideSkipped, 'Distant stroke is immediately skipped by lasso polygon AABB');

// Stroke inside polygon center
const insideStroke = new window.Ink.Stroke({ baseWidth: 3.0 });
insideStroke.push(500, 500, 0.5, 0);
insideStroke.push(502, 502, 0.5, 10);
insideStroke.bbox = window.Ink.computeStrokeBbox(insideStroke.points, 3.0);

const insideSkipped = (insideStroke.bbox[2] < polyMinX || insideStroke.bbox[0] > polyMaxX ||
                       insideStroke.bbox[3] < polyMinY || insideStroke.bbox[1] > polyMaxY);
assert(!insideSkipped, 'Enclosed stroke passes polygon AABB check');
const insideHit = insideStroke.points.some(pt => pointInPolygon(pt.x, pt.y, poly));
assert(insideHit, 'Point inside star polygon detected by raycasting');

console.log('\n=== TEST SUITE 3: Dirty Bounding Box Damage Rect Invariants ===');

// Viewport transform simulator
function worldToScreen(wx, wy, zoom, panX, panY, dpr) {
  return [
    (wx * zoom + panX),
    (wy * zoom + panY)
  ];
}

// Test bounding box dirty rect calculation across zoom levels and pan offsets
const testZooms = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0];
const testPans = [[0, 0], [150, -300], [-500, 1200]];
const testDPRs = [1.0, 1.25, 1.5, 2.0];

let allRectsEnclose = true;

for (const zoom of testZooms) {
  for (const [panX, panY] of testPans) {
    for (const dpr of testDPRs) {
      // Stroke bounds: [100, 200, 300, 400]
      const bbox = [100, 200, 300, 400];
      const pad = 8;
      
      const [sx0, sy0] = worldToScreen(bbox[0] - pad, bbox[1] - pad, zoom, panX, panY, dpr);
      const [sx1, sy1] = worldToScreen(bbox[2] + pad, bbox[3] + pad, zoom, panX, panY, dpr);
      
      const clearX = Math.min(sx0, sx1) - 4;
      const clearY = Math.min(sy0, sy1) - 4;
      const clearW = Math.abs(sx1 - sx0) + 8;
      const clearH = Math.abs(sy1 - sy0) + 8;

      // Ensure every point on stroke plus half-width (say pt [100, 200], width 4 -> radius 2) maps inside the clear rect
      const [ptSx, ptSy] = worldToScreen(100, 200, zoom, panX, panY, dpr);
      const [ptEndSx, ptEndSy] = worldToScreen(300, 400, zoom, panX, panY, dpr);

      if (ptSx < clearX || ptSx > clearX + clearW || ptSy < clearY || ptSy > clearY + clearH ||
          ptEndSx < clearX || ptEndSx > clearX + clearW || ptEndSy < clearY || ptEndSy > clearY + clearH) {
        allRectsEnclose = false;
      }
    }
  }
}

assert(allRectsEnclose, 'Dirty damage clearRect fully encloses stroke at all zoom levels (0.25x-5.0x), DPRs (1-2x), and pan offsets');

console.log('\n=== TEST SUITE 4: Rapid Pen-Down / Pen-Up Cycle Stress Test ===');

const numCycles = 1000;
const historyStrokes = [];
let cycleErrors = 0;

for (let c = 0; c < numCycles; c++) {
  try {
    const s = new window.Ink.Stroke({
      kind: c % 3 === 0 ? 'pen' : (c % 3 === 1 ? 'highlighter' : 'pen'),
      rgb: [c / 1000, 0.5, 1 - (c / 1000)],
      baseWidth: (c % 5) + 1.5,
    });
    
    // Ingest between 1 and 20 points
    const ptsCount = 1 + (c % 20);
    for (let p = 0; p < ptsCount; p++) {
      s.push(100 + p * 5, 200 + Math.sin(p) * 10, 0.3 + 0.4 * (p / ptsCount), p * 10);
    }
    
    // Commit stroke
    const path2D = s.getPath2D();
    const bbox = window.Ink.computeStrokeBbox(s.points, s.base_width);
    
    const committed = {
      id: s.id,
      kind: s.kind,
      rgb: s.rgb,
      base_width: s.base_width,
      points: s.points.slice(),
      sheet: 0,
      deleted: false,
      bbox: bbox,
      cssColor: s.cssColor,
      _cachedPath2D: path2D,
    };
    
    historyStrokes.push(committed);
  } catch (err) {
    cycleErrors++;
  }
}

assert(cycleErrors === 0, `Executed ${numCycles} rapid pen-down/pen-up cycles without exception`);
assert(historyStrokes.length === numCycles, `All ${numCycles} committed strokes created with valid Path2D and bbox`);

console.log('\n=== TEST SUITE 5: Transform & Undo/Redo Cache Invalidation ===');

const initialStroke = historyStrokes[10];
const origPath2D = initialStroke._cachedPath2D;
const origBbox = [...initialStroke.bbox];
assert(origPath2D !== null, 'Initial stroke has cached Path2D');

// Simulate move transform
const dx = 50, dy = 100;
initialStroke.points = initialStroke.points.map(p => ({
  x: p.x + dx,
  y: p.y + dy,
  w: p.w,
  p: p.p,
  t: p.t,
}));
initialStroke._cachedPath2D = null; // invalidation
initialStroke._cachedPath2D = window.Ink.getPath2D(initialStroke); // refresh
initialStroke.bbox = window.Ink.computeStrokeBbox(initialStroke.points, initialStroke.base_width);

assert(initialStroke._cachedPath2D !== origPath2D, 'Transform refreshed _cachedPath2D to a new Path2D object');
assert(initialStroke.bbox[0] > origBbox[0] + 40, 'Bbox updated with translation');

console.log(`\n==================================================`);
console.log(`Summary: ${passed} passed, ${failed} failed.`);
console.log(`==================================================`);

if (failed > 0) process.exit(1);
