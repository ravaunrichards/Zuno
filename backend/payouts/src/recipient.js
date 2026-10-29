'use strict';
const crypto = require('node:crypto');

function keyBytes(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const key = value.trim();
  let bytes = null;
  if (/^[a-f0-9]{64}$/i.test(key)) bytes = Buffer.from(key, 'hex');
  else {
    try { bytes = Buffer.from(key, 'base64'); } catch (_) { return null; }
  }
  return bytes && bytes.length === 32 ? bytes : null;
}
function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 127 || !/^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  return email;
}
function maskEmail(email) {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return (local.length <= 1 ? local : local.slice(0, 1) + '***') + '@' + domain;
}
function encryptRecipientEmail(value, key) {
  const email = normalizeEmail(value);
  if (!email) return { ok: false, code: 'PAYOUT_EMAIL_INVALID' };
  const secret = keyBytes(key);
  if (!secret) return { ok: false, code: 'PAYOUT_ENCRYPTION_KEY_NOT_CONFIGURED' };
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce);
  const ciphertext = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ok: true,
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    hash: crypto.createHash('sha256').update(email).digest('hex'),
    masked: maskEmail(email)
  };
}
function decryptRecipientEmail(record, key) {
  const secret = keyBytes(key);
  if (!secret) return { ok: false, code: 'PAYOUT_ENCRYPTION_KEY_NOT_CONFIGURED' };
  if (!record || !record.recipient_ciphertext || !record.recipient_nonce || !record.recipient_tag) {
    return { ok: false, code: 'PAYOUT_RECIPIENT_RECORD_INVALID' };
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, Buffer.from(record.recipient_nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(record.recipient_tag, 'base64'));
    const email = Buffer.concat([
      decipher.update(Buffer.from(record.recipient_ciphertext, 'base64')), decipher.final()
    ]).toString('utf8');
    const normalized = normalizeEmail(email);
    if (!normalized || crypto.createHash('sha256').update(normalized).digest('hex') !== record.recipient_hash) {
      return { ok: false, code: 'PAYOUT_RECIPIENT_INTEGRITY_FAILED' };
    }
    return { ok: true, email: normalized };
  } catch (_) {
    return { ok: false, code: 'PAYOUT_RECIPIENT_DECRYPT_FAILED' };
  }
}
module.exports = { keyBytes, normalizeEmail, maskEmail, encryptRecipientEmail, decryptRecipientEmail };
