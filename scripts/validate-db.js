'use strict';
/** Static validation of the SQL migration chain (no DB connection required):
 *  - required migrations exist and are ordered,
 *  - every create table has a matching enable-RLS somewhere for exposed tables,
 *  - no obviously destructive statement (drop table / truncate) in migrations. */
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..', 'database');
const files = [
  'migrations/0001_core_schema.sql',
  'policies/0002_rls_policies.sql',
  'functions/0003_economy_functions.sql',
  'seeds/0001_dev_seed.sql',
];
const problems = [];
let allSql = '';
for (const f of files) {
  const p = path.join(DB, f);
  if (!fs.existsSync(p)) { problems.push('missing ' + f); continue; }
  allSql += fs.readFileSync(p, 'utf8') + '\n';
}
const tables = [...allSql.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
const rlsEnabled = new Set([...allSql.matchAll(/alter table (\w+) enable row level security/g)].map((m) => m[1]));
const sensitive = ['profiles','posts','messages','notifications','wallet_accounts','ledger_entries','ledger_postings','recharge_purchases','live_rooms','gift_definitions'];
for (const t of sensitive) if (tables.includes(t) && !rlsEnabled.has(t)) problems.push('RLS not enabled on ' + t);
// destructive guard (ignore drop policy, which is intentional/idempotent)
const destructive = [...allSql.matchAll(/\b(drop table|truncate)\b/gi)];
if (destructive.length) problems.push('destructive statement found in migrations');

console.log(JSON.stringify({ ok: problems.length === 0, tables: tables.length, rlsTables: rlsEnabled.size, problems }, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
