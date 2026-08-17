/**
 * Investigation of findObjectAtWorld and eraseStrokesAt hit radii
 */

const assert = require('assert');

// Simulate stroke at (0,0) with baseWidth 10, point with w=10 (halfWidth=5)
const pt = { x: 0, y: 0, w: 10 };
const bbox = [-5, -5, 5, 5]; // from computeStrokeBbox

const radius = 10;
// Test point at wx = 16, wy = 0
const wx = 16, wy = 0;
const qMinX = wx - radius; // 6
const qMaxX = wx + radius; // 26
const qMinY = wy - radius; // -10
const qMaxY = wy + radius; // 10

// AABB check
const aabbRejected = (bbox[2] < qMinX || bbox[0] > qMaxX || bbox[3] < qMinY || bbox[1] > qMaxY);
console.log('AABB rejected at wx=16 (distance 16, ribbon radius 5, tolerance 10, total reach 15):', aabbRejected);

// Inner check with half-width (radius + pt.w/2 = 15)
const hitHalfWidth = Math.hypot(wx - pt.x, wy - pt.y) <= radius + pt.w / 2;
console.log('Geometric hit check (<= radius + pt.w/2):', hitHalfWidth);

// Inner check with full-width (radius + pt.w = 20)
const hitFullWidth = Math.hypot(wx - pt.x, wy - pt.y) <= radius + pt.w;
console.log('Legacy full-width check (<= radius + pt.w):', hitFullWidth);
