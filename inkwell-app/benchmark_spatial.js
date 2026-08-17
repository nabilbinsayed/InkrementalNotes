/**
 * Benchmark comparing AABB pre-filtered eraser vs naive linear O(N*M) search
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const sandbox = { window: {}, Math: Math, console: console };
vm.createContext(sandbox);
const inkJsCode = fs.readFileSync(path.join(__dirname, 'src', 'js', 'ink.js'), 'utf8');
vm.runInContext(inkJsCode, sandbox);
const Ink = sandbox.window.Ink;

console.log('=== Performance Benchmark: AABB Pre-filtering vs Naive O(N*M) ===');

const STROKE_COUNT = 10000;
const SAMPLES_PER_STROKE = 20;
const strokes = [];

for (let i = 0; i < STROKE_COUNT; i++) {
  const pts = [];
  const startX = Math.random() * 4000;
  const startY = Math.random() * 4000;
  for (let j = 0; j < SAMPLES_PER_STROKE; j++) {
    pts.push({
      x: startX + j * 2,
      y: startY + j * 2,
      w: 3.2
    });
  }
  const bbox = Ink.computeStrokeBbox(pts, 3.2);
  strokes.push({ id: i, points: pts, bbox, deleted: false, sheet: 0 });
}

const QUERIES = 5000;
const queryPoints = [];
for (let q = 0; q < QUERIES; q++) {
  queryPoints.push({
    x: Math.random() * 4000,
    y: Math.random() * 4000,
    radius: 16
  });
}

// 1. Naive Linear Search (checks every sample of every stroke)
const t0 = performance.now();
let naiveHits = 0;
for (const q of queryPoints) {
  for (const s of strokes) {
    for (const pt of s.points) {
      if (Math.hypot(pt.x - q.x, pt.y - q.y) < q.radius + pt.w / 2) {
        naiveHits++;
        break;
      }
    }
  }
}
const tNaive = performance.now() - t0;

// 2. AABB Pre-filtered Search
const t1 = performance.now();
let aabbHits = 0;
for (const q of queryPoints) {
  const qMinX = q.x - q.radius;
  const qMaxX = q.x + q.radius;
  const qMinY = q.y - q.radius;
  const qMaxY = q.y + q.radius;

  for (const s of strokes) {
    if (s.bbox[2] < qMinX || s.bbox[0] > qMaxX || s.bbox[3] < qMinY || s.bbox[1] > qMaxY) {
      continue;
    }
    for (const pt of s.points) {
      if (Math.hypot(pt.x - q.x, pt.y - q.y) < q.radius + pt.w / 2) {
        aabbHits++;
        break;
      }
    }
  }
}
const tAabb = performance.now() - t1;

assert.strictEqual(naiveHits, aabbHits, 'Hits must match exactly between naive and AABB');
console.log(`Naive O(N*M) Time (5,000 queries over 10,000 strokes / 200,000 samples): ${tNaive.toFixed(2)}ms`);
console.log(`AABB Pre-filtered Time: ${tAabb.toFixed(2)}ms`);
console.log(`Speedup Factor: ${(tNaive / tAabb).toFixed(2)}x faster (${((1 - tAabb / tNaive) * 100).toFixed(1)}% reduction in runtime)`);
console.log(`Hit counts matched exactly: ${aabbHits} hits`);
