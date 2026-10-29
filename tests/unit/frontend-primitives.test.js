'use strict';
const { test, ok, eq } = require('../../tools/test-harness');
const { renderFeatureCard, escapeHtml } = require('../../frontend/components/feature-card');
const { renderPageShell } = require('../../frontend/layouts/app-shell');
const nav = require('../../frontend/navigation/navigation-config');
const pages = require('../../frontend/pages/page-registry');
test('feature card escapes untrusted strings', () => {
  ok(renderFeatureCard({ title: '<script>', description: 'safe' }).includes('&lt;script&gt;'));
  eq(escapeHtml('"&'), '&quot;&amp;');
});
test('shared page shell marks active section and escapes page title', () => {
  const result = renderPageShell({ title: '<x>', activeSection: 'home', body: '<p>content</p>' });
  ok(result.includes('&lt;x&gt;'));
  ok(result.includes('data-active-section="home"'));
});
test('navigation and page registry use stable IDs', () => {
  ok(nav.some((item) => item.id === 'live'));
  eq(pages.wallet.requiresAuth, true);
});
