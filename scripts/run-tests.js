'use strict';
/** Discovers and runs all *.test.js under tests/ using the zero-dep harness. */
const fs = require('fs');
const path = require('path');
const harness = require('../tools/test-harness');

const ROOT = path.join(__dirname, '..', 'tests');
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.test.js')) acc.push(p);
  }
  return acc;
}

(async () => {
  const files = walk(ROOT).sort();
  console.log(`Loading ${files.length} test file(s):`);
  for (const f of files) { console.log('  ' + path.relative(path.join(__dirname, '..'), f)); require(f); }
  console.log('');
  const res = await harness.run();
  if (res.fail > 0) process.exit(1);
})();
