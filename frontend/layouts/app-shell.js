'use strict';
const { escapeHtml } = require('../components/feature-card');
function renderPageShell({ title, activeSection = 'Home', body }) {
  const safeBody = String(body == null ? '' : body);
  return '<div class="zuno-app-shell" data-active-section="' + escapeHtml(activeSection) + '"><header class="zuno-app-shell__header"><a href="/" aria-label="ZUNO home">ZUNO</a><span>' + escapeHtml(title) + '</span></header><main class="zuno-app-shell__content">' + safeBody + '</main></div>';
}
module.exports = { renderPageShell };
