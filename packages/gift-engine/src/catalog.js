'use strict';
/** ZUNO gift catalogue integrity: ids, prices, paths, procedural mesh schemas and binary checksums. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_PATH = path.join(__dirname, '..', 'data', 'gifts.json');
const MANIFEST_PATH = path.join(__dirname, '..', '..', '..', 'assets', 'manifests', 'gift-manifest.json');
const ALLOWED_SHAPES = new Set(['sphere','box','cone','torus','icosahedron','cylinder','tetrahedron']);

function loadGifts() { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
function loadManifest() { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); }
function checksum(filePath) {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
function safeAssetPath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..') return null;
  return resolved;
}
function validateGeometry(repoRoot, gift, manifestEntry, errors) {
  const modelPath = safeAssetPath(repoRoot, gift.modelPath);
  if (!modelPath || !fs.existsSync(modelPath)) {
    errors.push('missing or unsafe model asset for ' + gift.id + ': ' + gift.modelPath);
    return;
  }
  if (manifestEntry.modelPath !== gift.modelPath) errors.push('manifest/model path mismatch for ' + gift.id);
  try {
    const spec = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    if (spec.giftId !== gift.id) errors.push('geometry gift id mismatch for ' + gift.id);
    if (spec.format !== 'procedural-geometry-spec-v1' || spec.renderer !== 'three.js') errors.push('unsupported geometry format for ' + gift.id);
    if (!Array.isArray(spec.parts) || spec.parts.length < 1 || spec.parts.length > 32) errors.push('invalid geometry part count for ' + gift.id);
    for (const [index, part] of (Array.isArray(spec.parts) ? spec.parts : []).entries()) {
      if (!part || !ALLOWED_SHAPES.has(part.shape)) errors.push('unsupported geometry shape for ' + gift.id + ' part ' + index);
      if (!Number.isFinite(Number(part && part.scale)) || Number(part.scale) <= 0 || Number(part.scale) > 5) errors.push('invalid geometry scale for ' + gift.id + ' part ' + index);
      if (!/^#[0-9a-f]{6}$/i.test(String(part && part.color || ''))) errors.push('invalid geometry color for ' + gift.id + ' part ' + index);
      if (!Array.isArray(part && part.position) || part.position.length !== 3 || part.position.some(v => !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 5)) errors.push('invalid geometry position for ' + gift.id + ' part ' + index);
    }
    const actual = checksum(modelPath);
    if (manifestEntry.modelChecksum !== actual) errors.push('model checksum mismatch for ' + gift.id);
  } catch (error) {
    errors.push('invalid geometry JSON for ' + gift.id + ': ' + error.message);
  }
}
function validateAudio(repoRoot, gift, manifestEntry, errors) {
  if (!['resolved','not_required','unresolved'].includes(gift.audioStatus)) {
    errors.push('invalid audio status for ' + gift.id);
    return;
  }
  if (gift.audioStatus === 'resolved') {
    const audioPath = safeAssetPath(repoRoot, gift.audioPath);
    if (!audioPath || !fs.existsSync(audioPath)) {
      errors.push('missing or unsafe audio asset for ' + gift.id + ': ' + gift.audioPath);
      return;
    }
    if (manifestEntry.audioPath !== gift.audioPath) errors.push('manifest/audio path mismatch for ' + gift.id);
    const actual = checksum(audioPath);
    if (manifestEntry.audioChecksum !== actual) errors.push('audio checksum mismatch for ' + gift.id);
  } else {
    if (gift.audioPath !== null && gift.audioPath !== undefined) errors.push('non-resolved audio has an asset path for ' + gift.id);
    if (manifestEntry.audioPath !== null && manifestEntry.audioPath !== undefined) errors.push('manifest contains audio path for non-resolved gift ' + gift.id);
    if (manifestEntry.audioChecksum !== null && manifestEntry.audioChecksum !== undefined) errors.push('manifest contains audio checksum for non-resolved gift ' + gift.id);
  }
}
function validateCatalog(repoRoot) {
  const gifts = loadGifts();
  const manifest = loadManifest();
  const errors = [];
  const ids = new Set();
  const manifestEntries = Array.isArray(manifest.gifts) ? manifest.gifts : [];
  const manifestById = new Map();
  for (const entry of manifestEntries) {
    if (manifestById.has(entry.giftId)) errors.push('duplicate gift manifest id: ' + entry.giftId);
    else manifestById.set(entry.giftId, entry);
  }
  if (manifest.count !== gifts.length) errors.push('manifest count does not equal catalogue length');
  if (manifestEntries.length !== gifts.length) errors.push('manifest entries do not equal catalogue length');

  for (const gift of gifts) {
    if (!gift || typeof gift.id !== 'string' || !gift.id) {
      errors.push('gift has no stable id');
      continue;
    }
    if (ids.has(gift.id)) errors.push('duplicate gift id: ' + gift.id);
    ids.add(gift.id);
    if (!Number.isInteger(gift.priceCoins) || gift.priceCoins <= 0) errors.push('bad price for ' + gift.id);
    const entry = manifestById.get(gift.id);
    if (!entry) {
      errors.push('gift ' + gift.id + ' missing from manifest');
      continue;
    }
    if (entry.name !== gift.name || entry.category !== gift.category || Number(entry.priceCoins) !== gift.priceCoins) {
      errors.push('manifest product metadata mismatch for ' + gift.id);
    }
    validateGeometry(repoRoot, gift, entry, errors);
    validateAudio(repoRoot, gift, entry, errors);
  }
  for (const id of manifestById.keys()) if (!ids.has(id)) errors.push('manifest gift has no catalogue record: ' + id);
  return {
    ok: errors.length === 0,
    count: gifts.length,
    uniqueIds: ids.size,
    soundBearing: gifts.filter(g => g.audioStatus === 'resolved').length,
    unresolvedAudio: gifts.filter(g => g.audioStatus === 'unresolved').length,
    intentionallySilent: gifts.filter(g => g.audioStatus === 'not_required').length,
    errors
  };
}
function getGift(id) { return loadGifts().find(gift => gift.id === id) || null; }
module.exports = { loadGifts, loadManifest, validateCatalog, getGift, DATA_PATH, MANIFEST_PATH, checksum };
