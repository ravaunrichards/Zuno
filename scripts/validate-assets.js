'use strict';
const path = require('path');
const { validateCatalog } = require('../packages/gift-engine/src/catalog');
const r = validateCatalog(path.join(__dirname, '..'));
console.log(JSON.stringify({
  ok: r.ok, count: r.count, uniqueIds: r.uniqueIds,
  soundBearing: r.soundBearing, unresolvedAudio: r.unresolvedAudio,
  intentionallySilent: r.intentionallySilent,
  errors: r.errors.slice(0, 10),
}, null, 2));
process.exit(r.ok && r.count >= 100 ? 0 : 1);
