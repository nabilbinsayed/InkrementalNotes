/**
 * compare_geometry.js — JS half of the JS ↔ Rust geometry sync verification.
 * Loads ink.js, feeds a set of raw stroke samples through it, and outputs
 * the resulting filtered points as JSON.
 */

const fs = require('fs');
const path = require('path');

// Load ink.js from inkwell-m0/src/ink.js
const inkJsPath = path.join(__dirname, '..', '..', 'inkwell-m0', 'src', 'ink.js');
const inkJsContent = fs.readFileSync(inkJsPath, 'utf8');

// Evaluate ink.js in node context
const window = {};
const evalFn = new Function('window', inkJsContent);
evalFn(window);

const Ink = window.Ink;

// Test sample sequence (x, y, pressure, t_ms)
const testSamples = [
  [320.0, 321.333, 0.35, 5953.0],
  [319.926, 321.317, 0.1913, 5957.9],
  [319.705, 321.222, 0.1783, 5964.3],
  [319.242, 321.103, 0.1911, 5972.6],
  [318.824, 320.963, 0.2131, 5978.6],
  [317.988, 320.764, 0.2356, 5987.7],
  [317.253, 320.539, 0.2557, 5994.9],
  [316.267, 320.308, 0.2725, 6002.8],
  [315.289, 320.101, 0.2861, 6010.5],
  [314.25, 319.9, 0.2967, 6018.9]
];

const stroke = new Ink.Stroke({
  baseWidth: 3.2,
  minCutoff: 1.7,
  beta: 0.02,
  gamma: 1.0,
  smoothing: true
});

for (const [x, y, p, t] of testSamples) {
  stroke.push(x, y, p, t);
}

const result = {
  stroke_id: stroke.id,
  points: stroke.points.map(pt => ({ x: pt.x, y: pt.w ? pt.y : pt.y, w: pt.w }))
};

console.log(JSON.stringify(result, null, 2));
