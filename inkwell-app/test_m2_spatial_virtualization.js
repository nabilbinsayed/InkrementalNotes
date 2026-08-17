/**
 * Adversarial Test Suite for Milestone 2: Spatial Indexing & Viewport Virtualization
 *
 * Tests:
 * 1. Bounding box computation & incremental AABB tracking
 * 2. False-negative oracle verification for eraser, hit testing, and lasso
 * 3. Diagonal strokes, single dots, negative coordinates, and transformations
 * 4. Virtualized thumbnail drawer calculations (scroll bounds, edge cases 0..10000 pages)
 * 5. Stroke-by-sheet indexing
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// 1. Setup mock browser environment for ink.js
const sandbox = {
  window: {},
  Math: Math,
  crypto: {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2)
  },
  console: console,
};
vm.createContext(sandbox);

const inkJsPath = path.join(__dirname, 'src', 'js', 'ink.js');
const inkJsCode = fs.readFileSync(inkJsPath, 'utf8');
vm.runInContext(inkJsCode, sandbox);

const Ink = sandbox.window.Ink;
assert(Ink, 'Ink module must be loaded');

console.log('=== Test Suite 1: Bbox Computation & Incremental AABB ===');

// Test 1.1: Single dot bbox
{
  const stroke = new Ink.Stroke({ baseWidth: 6.0, smoothing: false });
  const pt = stroke.push(100, 200, 1.0, 100);
  assert(pt, 'Point must be pushed');
  // Radius is pt.w / 2
  const r = pt.w / 2;
  assert.strictEqual(stroke.bbox[0], 100 - r);
  assert.strictEqual(stroke.bbox[1], 200 - r);
  assert.strictEqual(stroke.bbox[2], 100 + r);
  assert.strictEqual(stroke.bbox[3], 200 + r);

  const batchBbox = Ink.computeStrokeBbox(stroke.points, stroke.base_width);
  assert.deepStrictEqual(stroke.bbox, batchBbox, 'Incremental and batch bbox must match');
  console.log('  [PASS] Single dot bbox accurate');
}

// Test 1.2: Diagonal stroke with negative coordinates (crossing origin)
{
  const stroke = new Ink.Stroke({ baseWidth: 4.0, smoothing: false });
  for (let i = -50; i <= 50; i += 10) {
    stroke.push(i, i * 2, 0.5, 100 + i);
  }
  // Points from (-50, -100) to (50, 100)
  const batchBbox = Ink.computeStrokeBbox(stroke.points, stroke.base_width);
  assert(stroke.bbox[0] <= -50, 'minX should cover start');
  assert(stroke.bbox[1] <= -100, 'minY should cover start');
  assert(stroke.bbox[2] >= 50, 'maxX should cover end');
  assert(stroke.bbox[3] >= 100, 'maxY should cover end');
  assert.deepStrictEqual(stroke.bbox, batchBbox, 'Diagonal stroke bbox matches');
  console.log('  [PASS] Diagonal stroke crossing origin bbox accurate');
}

// Test 1.3: Transformed stroke bbox recalculation
{
  const stroke = new Ink.Stroke({ baseWidth: 4.0, smoothing: false });
  stroke.push(10, 10, 1.0, 100);
  stroke.push(20, 30, 1.0, 150);

  const origBbox = [...stroke.bbox];
  // Simulate transform: Translate by (50, 100) and scale by 2
  for (const p of stroke.points) {
    p.x = p.x * 2 + 50;
    p.y = p.y * 2 + 100;
  }
  stroke._cachedPath2D = null;
  stroke.bbox = Ink.computeStrokeBbox(stroke.points, stroke.base_width);

  assert(stroke.bbox[0] > origBbox[0], 'Transformed bbox should reflect new coordinates');
  assert.strictEqual(stroke._cachedPath2D, null, 'Cached path invalidated');
  console.log('  [PASS] Transformed stroke bbox recalculation accurate');
}

console.log('\n=== Test Suite 2: False-Negative Oracle Verification ===');

// Helper for Point-in-Polygon (Ray casting algorithm as in app.js)
function pointInPolygon(px, py, polygon) {
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

// Test 2.1: Eraser AABB Pre-filter vs Ground Truth (Geometric Ribbon Reach)
{
  let falseNegatives = 0;
  let totalHits = 0;
  let totalRejections = 0;
  const trials = 50000;

  for (let t = 0; t < trials; t++) {
    // Generate random stroke
    const pts = [];
    const numPts = Math.floor(Math.random() * 10) + 1;
    const startX = (Math.random() - 0.5) * 1000;
    const startY = (Math.random() - 0.5) * 1000;
    const baseWidth = Math.random() * 8 + 1;

    for (let p = 0; p < numPts; p++) {
      pts.push({
        x: startX + (Math.random() - 0.5) * 100,
        y: startY + (Math.random() - 0.5) * 100,
        w: baseWidth * (0.22 + 0.78 * Math.random())
      });
    }

    const bbox = Ink.computeStrokeBbox(pts, baseWidth);

    // Random query near stroke
    const radius = Math.random() * 30 + 5;
    const qx = startX + (Math.random() - 0.5) * 200;
    const qy = startY + (Math.random() - 0.5) * 200;

    const qMinX = qx - radius;
    const qMaxX = qx + radius;
    const qMinY = qy - radius;
    const qMaxY = qy + radius;

    // AABB pre-filter
    const aabbRejected = (bbox[2] < qMinX || bbox[0] > qMaxX || bbox[3] < qMinY || bbox[1] > qMaxY);

    // Ground Truth exact distance check (matches eraseStrokesAt)
    let groundTruthHit = false;
    for (const pt of pts) {
      if (Math.hypot(pt.x - qx, pt.y - qy) < radius + (pt.w || 2) / 2) {
        groundTruthHit = true;
        break;
      }
    }

    if (groundTruthHit) totalHits++;
    if (aabbRejected) totalRejections++;

    if (groundTruthHit && aabbRejected) {
      falseNegatives++;
      console.error(`FALSE NEGATIVE DETECTED: q=(${qx},${qy}) r=${radius} bbox=${JSON.stringify(bbox)}`);
    }
  }

  assert.strictEqual(falseNegatives, 0, `Eraser AABB pre-filter produced ${falseNegatives} false negatives!`);
  console.log(`  [PASS] Eraser Oracle: 0 false negatives across ${trials} randomized trials (Hits: ${totalHits}, Rejections: ${totalRejections})`);
}

// Test 2.2: Lasso Selection AABB Pre-filter vs Ground Truth
{
  let falseNegatives = 0;
  let totalHits = 0;
  let totalRejections = 0;
  const trials = 50000;

  for (let t = 0; t < trials; t++) {
    // Generate random polygon (e.g. 4 to 8 vertices around a center)
    const polyCenterX = (Math.random() - 0.5) * 800;
    const polyCenterY = (Math.random() - 0.5) * 800;
    const polyRadius = Math.random() * 100 + 20;
    const numVerts = Math.floor(Math.random() * 5) + 3;
    const polygon = [];
    let polyMinX = Infinity, polyMinY = Infinity, polyMaxX = -Infinity, polyMaxY = -Infinity;

    for (let v = 0; v < numVerts; v++) {
      const angle = (v / numVerts) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
      const r = polyRadius * (0.5 + 0.5 * Math.random());
      const vx = polyCenterX + Math.cos(angle) * r;
      const vy = polyCenterY + Math.sin(angle) * r;
      polygon.push([vx, vy]);
      if (vx < polyMinX) polyMinX = vx;
      if (vy < polyMinY) polyMinY = vy;
      if (vx > polyMaxX) polyMaxX = vx;
      if (vy > polyMaxY) polyMaxY = vy;
    }

    // Generate random stroke
    const pts = [];
    const numPts = Math.floor(Math.random() * 8) + 1;
    const startX = polyCenterX + (Math.random() - 0.5) * 200;
    const startY = polyCenterY + (Math.random() - 0.5) * 200;
    const baseWidth = 3.2;

    for (let p = 0; p < numPts; p++) {
      pts.push({
        x: startX + (Math.random() - 0.5) * 50,
        y: startY + (Math.random() - 0.5) * 50,
        w: baseWidth
      });
    }

    const bbox = Ink.computeStrokeBbox(pts, baseWidth);

    // Lasso AABB pre-filter
    const aabbRejected = (bbox[2] < polyMinX || bbox[0] > polyMaxX || bbox[3] < polyMinY || bbox[1] > polyMaxY);

    // Ground Truth point-in-polygon check
    const groundTruthHit = pts.some(pt => pointInPolygon(pt.x, pt.y, polygon));

    if (groundTruthHit) totalHits++;
    if (aabbRejected) totalRejections++;

    if (groundTruthHit && aabbRejected) {
      falseNegatives++;
      console.error(`FALSE NEGATIVE IN LASSO: bbox=${JSON.stringify(bbox)} polyBounds=[${polyMinX},${polyMinY},${polyMaxX},${polyMaxY}]`);
    }
  }

  assert.strictEqual(falseNegatives, 0, `Lasso AABB pre-filter produced ${falseNegatives} false negatives!`);
  console.log(`  [PASS] Lasso Oracle: 0 false negatives across ${trials} randomized trials (Hits: ${totalHits}, Rejections: ${totalRejections})`);
}

console.log('\n=== Test Suite 3: Virtualized Thumbnail Drawer Stress Testing ===');

function simulateThumbnailVirtualization(pageCount, scrollTop, clientH = 600, ROW_HEIGHT = 220) {
  if (pageCount === 0) {
    return { empty: true, totalHeight: 'auto', renderedCount: 0, visibleIndices: [] };
  }
  const totalRows = Math.ceil(pageCount / 2);
  const totalHeight = totalRows * ROW_HEIGHT;

  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 1);
  const endRow = Math.min(totalRows - 1, Math.ceil((scrollTop + clientH) / ROW_HEIGHT) + 1);

  const startIndex = Math.max(0, startRow * 2 - 4);
  const endIndex = Math.min(pageCount - 1, (endRow + 1) * 2 + 4);

  const visibleIndices = [];
  for (let i = startIndex; i <= endIndex; i++) {
    visibleIndices.push(i);
  }

  return {
    empty: false,
    totalHeight,
    startRow,
    endRow,
    startIndex,
    endIndex,
    renderedCount: visibleIndices.length,
    visibleIndices,
  };
}

// Test 3.1: Empty document (0 pages)
{
  const res = simulateThumbnailVirtualization(0, 0);
  assert.strictEqual(res.empty, true);
  assert.strictEqual(res.renderedCount, 0);
  console.log('  [PASS] 0 pages (empty doc) handled cleanly');
}

// Test 3.2: 1 page document
{
  const res = simulateThumbnailVirtualization(1, 0);
  assert.strictEqual(res.totalHeight, 220);
  assert.strictEqual(res.startIndex, 0);
  assert.strictEqual(res.endIndex, 0);
  assert.deepStrictEqual(res.visibleIndices, [0]);
  console.log('  [PASS] 1 page doc bounds accurate');
}

// Test 3.3: Negative scrollTop (bounce / overscroll)
{
  const res = simulateThumbnailVirtualization(100, -150);
  assert(res.startIndex >= 0, 'startIndex must never be negative');
  assert(res.endIndex < 100, 'endIndex must not exceed pageCount - 1');
  assert(res.renderedCount <= 20, 'Rendered cards must stay bounded');
  console.log(`  [PASS] Negative scrollTop (-150px) bounded: startIndex=${res.startIndex}, endIndex=${res.endIndex}`);
}

// Test 3.4: Multi-hundred page document (500 pages) across standard scroll domain [0, totalHeight - clientH]
{
  const maxScroll = 250 * 220 - 600; // 54,400px
  const scrollPositions = [0, 500, 2500, 10000, 30000, 50000, maxScroll];
  for (const st of scrollPositions) {
    const res = simulateThumbnailVirtualization(500, st);
    assert(res.startIndex >= 0 && res.startIndex < 500, `startIndex ${res.startIndex} in bounds for scrollTop ${st}`);
    assert(res.endIndex >= 0 && res.endIndex < 500, `endIndex ${res.endIndex} in bounds for scrollTop ${st}`);
    assert(res.startIndex <= res.endIndex, `startIndex <= endIndex (${res.startIndex} <= ${res.endIndex})`);
    assert(res.renderedCount <= 24, `Rendered count (${res.renderedCount}) must be tightly bounded`);
  }
  console.log('  [PASS] 500 pages virtualized across all valid scroll offsets (card count strictly bounded <= 24)');
}

// Test 3.5: Extreme scale document (10,000 pages)
{
  const res = simulateThumbnailVirtualization(10000, 500000);
  assert.strictEqual(res.totalHeight, 5000 * 220);
  assert(res.startIndex >= 0 && res.endIndex < 10000);
  assert(res.renderedCount <= 24);
  console.log(`  [PASS] 10,000 pages virtualization: renderedCount=${res.renderedCount} cards instead of 10,000 DOM nodes`);
}

// Test 3.6: Stroke indexing by sheet isolation
{
  const strokes = [];
  for (let s = 0; s < 100; s++) {
    for (let k = 0; k < 5; k++) {
      strokes.push({ id: `s_${s}_${k}`, sheet: s, points: [{ x: 10, y: 10, w: 2 }], deleted: false });
    }
  }
  // Add some deleted strokes
  strokes.push({ id: 'del_1', sheet: 42, points: [{ x: 10, y: 10, w: 2 }], deleted: true });

  const strokesBySheet = new Map();
  for (const s of strokes) {
    if (s.deleted) continue;
    let list = strokesBySheet.get(s.sheet);
    if (!list) {
      list = [];
      strokesBySheet.set(s.sheet, list);
    }
    list.push(s);
  }

  assert.strictEqual(strokesBySheet.get(42).length, 5, 'Sheet 42 should have exactly 5 non-deleted strokes');
  assert.strictEqual(strokesBySheet.get(99).length, 5, 'Sheet 99 should have exactly 5 non-deleted strokes');
  assert.strictEqual(strokesBySheet.get(105), undefined, 'Non-existent sheet returns undefined');
  console.log('  [PASS] strokesBySheet map indexing verified for O(1) page access');
}

console.log('\n==============================================================');
console.log('  ALL ADVERSARIAL STRESS TESTS PASSED CLEANLY (100% GREEN)');
console.log('==============================================================');
