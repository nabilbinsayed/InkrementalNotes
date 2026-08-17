// Adversarial stress test for ink.js engine
const fs = require('fs');
const path = require('path');

// Mock browser globals for ink.js if running in Node
global.window = global;
global.crypto = require('crypto');

// Minimal Path2D mock to verify path operations without a browser canvas
class MockPath2D {
  constructor() {
    this.ops = [];
  }
  moveTo(x, y) { this.ops.push(['moveTo', x, y]); }
  lineTo(x, y) { this.ops.push(['lineTo', x, y]); }
  arc(x, y, r, sa, ea) { this.ops.push(['arc', x, y, r, sa, ea]); }
  quadraticCurveTo(cx, cy, x, y) { this.ops.push(['quadraticCurveTo', cx, cy, x, y]); }
  closePath() { this.ops.push(['closePath']); }
}
global.Path2D = MockPath2D;

// Load ink.js from inkwell-app/src/js/ink.js
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

console.log('=== TEST SUITE 1: OneEuro and Streamline Filter Invariants ===');

// 1. OneEuro with zero, normal, and extreme dt
const oe = new window.Ink.OneEuro(1.1, 0.006, 1.0);
let v1 = oe.filter(100, 0);
assert(!isNaN(v1) && isFinite(v1), 'OneEuro initial value is finite');

// High frequency samples (e.g. 1000 Hz, dt = 1ms)
let vPrev = v1;
let allFinite = true;
for (let i = 1; i <= 1000; i++) {
  let v = oe.filter(100 + Math.sin(i * 0.1) * 5, i);
  if (isNaN(v) || !isFinite(v)) allFinite = false;
}
assert(allFinite, 'OneEuro handles 1,000 samples @ 1000Hz without NaN/Inf');

// Extreme time delta (dt = 0 or negative or huge)
const vZeroDt = oe.filter(150, 1000); // same timestamp
assert(!isNaN(vZeroDt) && isFinite(vZeroDt), 'OneEuro handles dt = 0 gracefully (clamped to 1e-4)');

const vHugeDt = oe.filter(200, 1000000); // 1000s jump
assert(!isNaN(vHugeDt) && isFinite(vHugeDt), 'OneEuro handles huge dt gracefully');

// Streamline lerp invariants
const sl = new window.Ink.Streamline(0.45, 0.35);
const p0 = sl.filter(10, 20, 0.5);
assert(p0.x === 10 && p0.y === 20 && p0.p === 0.5, 'Streamline first point is exact');

const p1 = sl.filter(20, 40, 1.0);
assert(Math.abs(p1.x - (10 + 10 * 0.45)) < 1e-5, 'Streamline position lerp accurate');
assert(Math.abs(p1.p - (0.5 + 0.5 * 0.35)) < 1e-5, 'Streamline pressure lerp accurate');

console.log('\n=== TEST SUITE 2: Stroke Lifecycle, Deduping & Bounding Box ===');

// 1. Empty stroke
const emptyStroke = new window.Ink.Stroke();
assert(emptyStroke.points.length === 0, 'Empty stroke has 0 points');
assert(emptyStroke.getPath2D() === null, 'Empty stroke returns null Path2D');

// 2. Single-point dot stroke
const dotStroke = new window.Ink.Stroke({ baseWidth: 4.0, rgb: [1, 0, 0] });
const dotPt = dotStroke.push(50, 50, 0.5, 100);
assert(dotPt !== null, 'Single point push returns point');
assert(dotStroke.points.length === 1, 'Single point dot stroke has 1 point');
assert(dotStroke.bbox[0] < 50 && dotStroke.bbox[2] > 50, 'Dot stroke AABB encloses dot radius in X');
assert(dotStroke.bbox[1] < 50 && dotStroke.bbox[3] > 50, 'Dot stroke AABB encloses dot radius in Y');

const dotPath = dotStroke.getPath2D();
assert(dotPath !== null && dotPath.ops.length > 0, 'Single point dot generates valid Path2D');
assert(dotStroke.getPath2D() === dotPath, 'getPath2D memoizes _cachedPath2D');

// 3. Duplicate sample deduping (< 0.05px distance)
const dedupStroke = new window.Ink.Stroke();
const ptA = dedupStroke.push(100, 100, 0.5, 0);
const ptB = dedupStroke.push(100.01, 100.01, 0.5, 1);
assert(ptA !== null && ptB === null, 'Sub-0.05px jitter is deduped (returns null)');
assert(dedupStroke.points.length === 1, 'Dedup stroke does not add redundant point');

// 4. Two-point segment stroke
const segStroke = new window.Ink.Stroke({ baseWidth: 4.0 });
segStroke.push(0, 0, 0.5, 0);
segStroke.push(100, 100, 0.5, 10);
assert(segStroke.points.length === 2, 'Two-point stroke has 2 points');
const segPath = segStroke.getPath2D();
assert(segPath !== null && segPath.ops.length >= 2, 'Two-point stroke creates Path2D with dot + segment');

// 5. Multi-point smooth ribbon stroke
const ribbonStroke = new window.Ink.Stroke({ baseWidth: 3.2 });
for (let i = 0; i < 50; i++) {
  ribbonStroke.push(i * 10, Math.sin(i * 0.2) * 50, 0.2 + 0.6 * (i / 50), i * 16);
}
assert(ribbonStroke.points.length === 50, '50-point stroke created successfully');
const ribbonPath = ribbonStroke.getPath2D();
assert(ribbonPath !== null && ribbonPath.ops.length > 50, 'Multi-point stroke creates interpolated ribbon Path2D');

// 6. Highlighter chisel path
const hlStroke = new window.Ink.Stroke({ kind: 'highlighter', baseWidth: 16.0 });
for (let i = 0; i < 20; i++) {
  hlStroke.push(i * 20, 100, 0.8, i * 16);
}
const hlPath = hlStroke.getPath2D();
assert(hlPath !== null && hlPath.ops.length > 0, 'Chisel highlighter creates Path2D');
const hasClose = hlPath.ops.some(op => op[0] === 'closePath');
assert(hasClose, 'Chisel highlighter path is closed');

console.log('\n=== TEST SUITE 3: computeStrokeBbox and Spatial Bounding Boxes ===');

// Test computeStrokeBbox vs incremental bbox
const testPts = [
  { x: 10, y: 20, w: 4.0 },
  { x: 100, y: 50, w: 6.0 },
  { x: 50, y: 200, w: 2.0 },
];
const computedBbox = window.Ink.computeStrokeBbox(testPts);
assert(computedBbox[0] === 10 - 2.0, `computeStrokeBbox minX correct: ${computedBbox[0]} === 8`);
assert(computedBbox[1] === 20 - 2.0, `computeStrokeBbox minY correct: ${computedBbox[1]} === 18`);
assert(computedBbox[2] === 100 + 3.0, `computeStrokeBbox maxX correct: ${computedBbox[2]} === 103`);
assert(computedBbox[3] === 200 + 1.0, `computeStrokeBbox maxY correct: ${computedBbox[3]} === 201`);

// Empty & degenerate point lists
assert(JSON.stringify(window.Ink.computeStrokeBbox([])) === '[0,0,0,0]', 'Empty point list returns [0,0,0,0]');
assert(JSON.stringify(window.Ink.computeStrokeBbox(null)) === '[0,0,0,0]', 'Null point list returns [0,0,0,0]');

console.log('\n=== TEST SUITE 4: High-Load Stress Testing (100,000 Samples) ===');

const stressStroke = new window.Ink.Stroke({ baseWidth: 2.5 });
const t0 = performance.now();
for (let i = 0; i < 100000; i++) {
  const x = (i * 0.1) % 800;
  const y = 100 + Math.sin(i * 0.05) * 50;
  const p = 0.2 + 0.6 * ((i % 100) / 100);
  stressStroke.push(x, y, p, i * 4);
}
const elapsedMs = performance.now() - t0;
const perSampleUs = (elapsedMs / 100000) * 1000;
assert(stressStroke.points.length > 50000, `Processed ${stressStroke.points.length} points from 100k samples`);
assert(perSampleUs < 50, `Hot loop latency: ${perSampleUs.toFixed(3)} µs/sample (< 50 µs target, i.e. < 0.05ms)`);

console.log(`\n==================================================`);
console.log(`Summary: ${passed} passed, ${failed} failed.`);
console.log(`==================================================`);

if (failed > 0) process.exit(1);
