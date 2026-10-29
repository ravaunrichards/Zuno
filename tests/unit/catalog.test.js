'use strict';
const path = require('path');
const { test, eq, ok } = require('../../tools/test-harness');
const cat = require('../../packages/gift-engine/src/catalog');

const REPO_ROOT = path.join(__dirname, '..', '..');

test('catalog has >= 100 distinct gifts', () => {
  const gifts = cat.loadGifts();
  ok(gifts.length >= 100, `expected >=100, got ${gifts.length}`);
  const ids = new Set(gifts.map((g) => g.id));
  eq(ids.size, gifts.length, 'all ids unique');
});

test('every gift has stable id + positive integer price', () => {
  for (const g of cat.loadGifts()) {
    ok(typeof g.id === 'string' && g.id.startsWith('gift_'), `bad id ${g.id}`);
    ok(Number.isInteger(g.priceCoins) && g.priceCoins > 0, `bad price ${g.id}`);
  }
});

test('manifest validates against packaged asset files', () => {
  const r = cat.validateCatalog(REPO_ROOT);
  if (!r.ok) throw new Error('manifest errors: ' + r.errors.slice(0, 5).join('; '));
  ok(r.count >= 100, 'count');
  ok(r.soundBearing > 0, 'has sound-bearing gifts with real audio');
});
