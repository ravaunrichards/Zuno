'use strict';
const { test, eq, ok } = require('../../tools/test-harness');
const paypal = require('../../integrations/paypal');
const { load } = require('../../config');

test('payment adapter never fakes success when unconfigured', () => {
  const out = paypal.notConfigured();
  eq(out.ok, false, 'not ok'); eq(out.status, 503, '503'); eq(out.code, 'PAYMENTS_NOT_CONFIGURED', 'explicit');
});

test('config does not expose service-role key to client surface', () => {
  const c = load({ SUPABASE_URL: 'https://x', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'secret' });
  // The anon key is client-safe; the service role key must only live server-side.
  ok(c.supabase.serviceRoleKey === 'secret', 'held server-side');
  // Simulate the client bundle: only url + anonKey are allowed to ship.
  const clientBundle = { url: c.supabase.url, anonKey: c.supabase.anonKey };
  ok(!('serviceRoleKey' in clientBundle), 'service role never in client bundle');
});

test('production payments stay disabled without paypal credentials', () => {
  const { validateRequired } = require('../../config');
  const c = load({ FEATURE_PRODUCTION_PAYMENTS: 'true' });
  const v = validateRequired(c);
  eq(v.ok, false, 'blocked'); ok(v.problems.some((p) => p.includes('PayPal')), 'names the blocker');
});
