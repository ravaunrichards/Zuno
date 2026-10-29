'use strict';
/** Shared UI primitives (framework-agnostic render helpers returning HTML
 *  strings for the PWA shell; the React/Native apps wrap these tokens in their
 *  own components). Business logic lives in backend/packages, never here. */
const tokens = require('../../design-system/src/tokens');
const { escapeHtml } = require('../../validation/src/index');

function button(label, opts = {}) {
  const bg = opts.variant === 'ghost' ? 'transparent' : tokens.color.brand;
  return `<button class="zuno-btn" style="background:${bg};color:${tokens.color.text};border-radius:${tokens.radius.pill};padding:10px 18px;border:0;font-family:${tokens.font.sans};cursor:pointer">${escapeHtml(label)}</button>`;
}
function stateView(kind, message) {
  const map = { loading: 'Loading\u2026', empty: 'Nothing here yet', error: 'Something went wrong', offline: 'You are offline', unauthorized: 'Sign in to continue' };
  return `<div class="zuno-state zuno-state-${escapeHtml(kind)}" role="status">${escapeHtml(message || map[kind] || '')}</div>`;
}
module.exports = { button, stateView, tokens };
