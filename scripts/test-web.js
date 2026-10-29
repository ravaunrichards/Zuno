'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..','apps','web');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
const css = fs.readFileSync(path.join(root,'src/styles/responsive.css'),'utf8');
const checks = [
  ['homepage branding', html.includes('ZUNO — Your world, all in one place')],
  ['responsive stylesheet entry', html.includes('./src/styles/main.css')],
  ['ecosystem navigation', ['discover','live','messages','communities','creator','wallet','profile'].every((id) => html.includes('href="#' + id + '"'))],
  ['local draft disclosure', html.includes('Draft is saved only on this device.')],
  ['gift inspection disclosure', html.includes('No coins are spent and no gift is sent.')],
  ['live data honesty', html.includes('No live room list is being shown as real')],
  ['skip link', html.includes('Skip to content')],
  ['reduced motion', css.includes('prefers-reduced-motion')],
  ['real gift catalogue source', fs.existsSync(path.join(root,'gifts.json'))],
  ['module layout', fs.existsSync(path.join(root,'src/features/gifts/catalog.js'))]
];
let failed = 0;
for (const [name, pass] of checks) { console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + name); if (!pass) failed += 1; }
console.log((checks.length-failed) + '/' + checks.length + ' web checks passed');
if (failed) process.exit(1);
