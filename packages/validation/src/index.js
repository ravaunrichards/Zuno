'use strict';
/** Shared input validation. Used at every trust boundary (API routes). */
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function isUuidLike(v) { return typeof v === 'string' && /^[0-9a-zA-Z_\-:]{1,80}$/.test(v); }
function isPositiveInt(v) { return Number.isInteger(v) && v > 0; }

function validateGiftSend(body) {
  const errors = [];
  if (!isNonEmptyString(body.senderId)) errors.push('senderId required');
  if (!isNonEmptyString(body.recipientId)) errors.push('recipientId required');
  if (!isNonEmptyString(body.giftId)) errors.push('giftId required');
  if (!isNonEmptyString(body.idempotencyKey)) errors.push('idempotencyKey required');
  return { ok: errors.length === 0, errors };
}

function validateUsername(name) {
  return typeof name === 'string' && /^[a-z0-9_.]{3,30}$/.test(name);
}

/** Basic HTML escaping for any user-supplied text rendered into HTML. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { isNonEmptyString, isUuidLike, isPositiveInt, validateGiftSend, validateUsername, escapeHtml };
