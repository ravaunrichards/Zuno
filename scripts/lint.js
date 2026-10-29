'use strict';
/** Lightweight lint: node --check every .js under packages/backend/integrations/config/scripts/tools. */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DIRS = ['packages', 'backend', 'integrations', 'config', 'scripts', 'tools', 'frontend', 'apps'];
let checked = 0, failed = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name === 'node_modules') continue;
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      checked++;
      try { execSync(`node --check "${p}"`, { stdio: 'pipe' }); }
      catch (err) { failed++; console.error('SYNTAX ERROR:', path.relative(ROOT, p)); console.error(String(err.stderr || err)); }
    }
  }
}
for (const d of DIRS) walk(path.join(ROOT, d));
console.log(`lint: ${checked} files checked, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
