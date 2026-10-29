'use strict';
/** Extensible localization. English ships now; add locales as JSON files here. */
const fs = require('fs');
const path = require('path');
const cache = {};
function load(locale = 'en') {
  if (cache[locale]) return cache[locale];
  const p = path.join(__dirname, `${locale}.json`);
  const data = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  cache[locale] = data; return data;
}
function t(key, locale = 'en', fallback = '') {
  const data = load(locale);
  return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), data) ?? fallback ?? key;
}
function formatCurrency(amount, currency = 'USD', locale = 'en-US') {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount); }
  catch (_) { return `${currency} ${amount}`; }
}
module.exports = { load, t, formatCurrency };
