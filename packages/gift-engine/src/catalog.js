'use strict';
/** ZUNO gift catalog: loads the generated data-driven catalog and validates integrity. */
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'gifts.json');
const MANIFEST_PATH = path.join(__dirname, '..', '..', '..', 'assets', 'manifests', 'gift-manifest.json');

function loadGifts() {
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
}
function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/** Validate catalog + manifest: unique stable ids, resolvable asset paths, price integrity. */
function validateCatalog(repoRoot) {
  const gifts = loadGifts();
  const manifest = loadManifest();
  const errors = [];
  const ids = new Set();
  for (const g of gifts) {
    if (ids.has(g.id)) errors.push(`duplicate gift id: ${g.id}`);
    ids.add(g.id);
    if (!Number.isInteger(g.priceCoins) || g.priceCoins <= 0) errors.push(`bad price for ${g.id}`);
    const model = path.join(repoRoot, g.modelPath);
    if (!fs.existsSync(model)) errors.push(`missing model asset for ${g.id}: ${g.modelPath}`);
    if (g.audioStatus === 'resolved') {
      const audio = path.join(repoRoot, g.audioPath);
      if (!fs.existsSync(audio)) errors.push(`missing audio asset for ${g.id}: ${g.audioPath}`);
    }
  }
  const manifestIds = new Set(manifest.gifts.map((m) => m.giftId));
  for (const id of ids) if (!manifestIds.has(id)) errors.push(`gift ${id} missing from manifest`);
  return {
    ok: errors.length === 0,
    count: gifts.length,
    uniqueIds: ids.size,
    soundBearing: gifts.filter((g) => g.audioStatus === 'resolved').length,
    unresolvedAudio: gifts.filter((g) => g.audioStatus === 'unresolved').length,
    errors,
  };
}

function getGift(id) {
  return loadGifts().find((g) => g.id === id) || null;
}

module.exports = { loadGifts, loadManifest, validateCatalog, getGift, DATA_PATH, MANIFEST_PATH };
