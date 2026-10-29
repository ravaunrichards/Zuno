'use strict';
/** Zero-dependency test harness so the economy core has a real green signal
 *  in a sandbox with no test framework installed. */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || 'eq'}: expected ${sb}, got ${sa}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function throws(fn, code, msg) {
  try { fn(); } catch (e) {
    if (code && e.code !== code) throw new Error(`${msg || 'throws'}: expected code ${code}, got ${e.code}`);
    return;
  }
  throw new Error(msg || 'expected throw');
}
async function run() {
  let pass = 0, fail = 0; const failures = [];
  for (const t of tests) {
    try { await t.fn(); pass++; process.stdout.write('.'); }
    catch (e) { fail++; failures.push({ name: t.name, err: e.message }); process.stdout.write('F'); }
  }
  process.stdout.write('\n');
  for (const f of failures) console.error(`FAIL: ${f.name}\n    ${f.err}`);
  console.log(`\n${pass} passed, ${fail} failed, ${tests.length} total`);
  if (fail > 0) process.exitCode = 1;
  return { pass, fail, total: tests.length };
}
module.exports = { test, eq, ok, throws, run };
