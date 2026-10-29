'use strict';
/** Runs every offline check available in this environment and writes
 *  verification/verification-report.json with honest PASS/FAIL results. */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function run(name, cmd) {
  const started = Date.now();
  try {
    const out = execSync(cmd, { cwd: ROOT, stdio: 'pipe' }).toString();
    return { name, cmd, status: 'PASS', ms: Date.now() - started, output: out.trim().split('\n').slice(-6).join('\n') };
  } catch (e) {
    return { name, cmd, status: 'FAIL', ms: Date.now() - started, output: String(e.stdout || e.stderr || e.message).trim().split('\n').slice(-10).join('\n') };
  }
}

const checks = [
  run('lint (node --check)', 'node scripts/lint.js'),
  run('automated tests', 'node scripts/run-tests.js'),
  run('asset + gift-catalog validation', 'node scripts/validate-assets.js'),
  run('database migration validation', 'node scripts/validate-db.js'),
  run('platform entrypoint validation', 'node scripts/validate-platforms.js'),
  run('environment check', 'node scripts/check-env.js'),
];

const summary = {
  project: 'ZUNO', generatedAt: new Date().toISOString(),
  node: process.version,
  passed: checks.filter((c) => c.status === 'PASS').length,
  failed: checks.filter((c) => c.status === 'FAIL').length,
  checks,
};
fs.mkdirSync(path.join(ROOT, 'verification'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'verification', 'verification-report.json'), JSON.stringify(summary, null, 2));
console.log(`verify: ${summary.passed} passed, ${summary.failed} failed`);
for (const c of checks) console.log(`  [${c.status}] ${c.name}`);
process.exit(summary.failed === 0 ? 0 : 1);
