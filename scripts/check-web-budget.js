'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'apps', 'web', 'dist');
const limits = { jsBytes: 1500 * 1024, cssBytes: 800 * 1024, totalBytes: 3 * 1024 * 1024, gzipBytes: 1024 * 1024 };
const problems = [];
const files = [];
function walk(folder) {
  if (!fs.existsSync(folder)) return;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|mjs|css|html|json|webmanifest|svg|woff2?)$/i.test(entry.name)) files.push(full);
  }
}
walk(dist);
if (!fs.existsSync(dist)) problems.push('web build output directory is missing; run the web build first');
const total = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
const jsBytes = files.filter(file => /\.(?:js|mjs)$/i.test(file)).reduce((sum, file) => sum + fs.statSync(file).size, 0);
const cssBytes = files.filter(file => /\.css$/i.test(file)).reduce((sum, file) => sum + fs.statSync(file).size, 0);
const gzipBytes = files.filter(file => /\.(?:js|mjs|css|html|json|webmanifest)$/i.test(file))
  .reduce((sum, file) => sum + zlib.gzipSync(fs.readFileSync(file)).length, 0);
if (files.length === 0) problems.push('no measurable web assets found');
if (jsBytes > limits.jsBytes) problems.push('JavaScript size exceeds 1,500 KiB');
if (cssBytes > limits.cssBytes) problems.push('CSS size exceeds 800 KiB');
if (total > limits.totalBytes) problems.push('combined static text asset size exceeds 3 MiB');
if (gzipBytes > limits.gzipBytes) problems.push('combined gzip size of text assets exceeds 1 MiB');
console.log(JSON.stringify({
  ok: problems.length === 0,
  fileCount: files.length,
  rawBytes: total,
  jsBytes,
  cssBytes,
  compressedTextBytes: gzipBytes,
  limits,
  problems
}, null, 2));
process.exit(problems.length ? 1 : 0);
