'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..','apps','web');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
const css = fs.readFileSync(path.join(root,'src/styles/responsive.css'),'utf8');
const giftCatalog = fs.readFileSync(path.join(root,'src/features/gifts/catalog.js'),'utf8');
const giftArtwork = fs.readFileSync(path.join(root,'src/features/gifts/artwork.js'),'utf8');
const authSession = fs.readFileSync(path.join(root,'src/features/auth/session.js'),'utf8');
const bundledGifts = JSON.parse(fs.readFileSync(path.join(root,'gifts.json'),'utf8'));
const checks = [
  ['homepage branding', html.includes('ZUNO — Your world, all in one place')],
  ['responsive stylesheet entry', html.includes('./src/styles/main.css')],
  ['ecosystem navigation', ['discover','live','messages','communities','creator','wallet','profile'].every((id) => html.includes('href="#' + id + '"'))],
  ['local draft disclosure', html.includes('Draft is saved only on this device.')],
  ['gift sending is explicit', html.includes('Inspecting a gift never spends coins') && html.includes('id="gift-send-form"')],
  ['unresolved gift audio is documented', fs.readFileSync(path.join(root,'gifts.json'),'utf8').includes('audioReason')],
  ['live data honesty', html.includes('No live room list is being shown as real')],
  ['skip link', html.includes('Skip to content')],
  ['reduced motion', css.includes('prefers-reduced-motion')],
  ['real gift catalogue source', fs.existsSync(path.join(root,'gifts.json'))],
  ['module layout', fs.existsSync(path.join(root,'src/features/gifts/catalog.js'))],
  ['gift illustrations render without WebGL', giftCatalog.includes('giftArtwork(gift)') && !giftCatalog.includes('mountGiftPreviews') && giftArtwork.includes('export function giftArtwork')],
  ['bundled gift wrapper and API catalog normalize IDs', giftCatalog.includes('Array.isArray(parsed.gifts)') && giftCatalog.includes('gift.id || gift.giftId') && Array.isArray(bundledGifts.gifts)],
  ['all gift families can be filtered', ['animals','vehicles','music','luxury','creator_support','seasonal','premium'].every((category) => html.includes('data-gift-category="' + category + '"'))],
  ['auth email links never use localhost from local signup', authSession.includes("const DEFAULT_PUBLIC_WEB_URL = 'https://zuno-web-corrected.onrender.com'") && authSession.includes('isLocalHostname(current.hostname)') && authSession.includes("redirect.searchParams.set('auth', state)") ]
];
let failed = 0;
for (const [name, pass] of checks) { console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + name); if (!pass) failed += 1; }
console.log((checks.length-failed) + '/' + checks.length + ' web checks passed');
if (failed) process.exit(1);
