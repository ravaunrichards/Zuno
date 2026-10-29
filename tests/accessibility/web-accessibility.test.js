'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test, ok } = require('../../tools/test-harness');
const root = path.join(__dirname, '..', '..', 'apps', 'web');
test('homepage defines a skip link and landmark navigation', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ok(html.includes('Skip to content'));
  ok(html.includes('aria-label="Main navigation"'));
  ok(html.includes('<main id="main"'));
});
test('responsive style respects reduced motion', () => {
  const css = fs.readFileSync(path.join(root, 'src/styles/responsive.css'), 'utf8');
  ok(css.includes('prefers-reduced-motion:reduce'));
});
