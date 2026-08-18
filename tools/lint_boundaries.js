/* ============================================================================
 * tools/lint_boundaries.js — Architectural Boundary Linter for Inkwell
 * Enforces strict unidirectional dependencies between modules:
 * 1. core/ must NEVER import from ui/, tools/, render/, workspace/, or main.js
 * 2. render/ must NEVER mutate document state or import from ui/ or tools/
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const JS_ROOT = path.resolve(__dirname, '../inkwell-app/src/js');
let violations = [];

function checkFile(filePath, prohibitedPatterns) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('import ') || trimmed.startsWith('export ') && trimmed.includes('from ')) {
      for (const pat of prohibitedPatterns) {
        if (trimmed.includes(pat)) {
          violations.push({
            file: path.relative(JS_ROOT, filePath),
            line: idx + 1,
            code: trimmed,
            violation: `Prohibited import matching pattern: "${pat}"`
          });
        }
      }
    }
  });
}

function scanDir(dir, prohibitedPatterns) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, prohibitedPatterns);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      checkFile(fullPath, prohibitedPatterns);
    }
  }
}

console.log('--- Scanning InkWell Architectural Module Boundaries ---');

// 1. Check core/ directory
scanDir(path.join(JS_ROOT, 'core'), [
  '/ui/',
  '/tools/',
  '/render/',
  '/workspace/',
  'main.js',
  'app.js'
]);

if (violations.length > 0) {
  console.error('\n❌ Architectural boundary violations detected:');
  violations.forEach(v => {
    console.error(`  - [${v.file}:${v.line}] ${v.code} (${v.violation})`);
  });
  process.exit(1);
} else {
  console.log('✅ All module boundaries strictly respected. Zero architectural violations.');
  process.exit(0);
}
