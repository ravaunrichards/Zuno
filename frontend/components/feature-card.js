'use strict';
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
function renderFeatureCard({ title, description, href = '#', eyebrow = '' }) {
  return '<article class="zuno-feature-card"><span class="zuno-feature-card__eyebrow">' + escapeHtml(eyebrow) + '</span><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(description) + '</p><a href="' + escapeHtml(href) + '">Explore <span aria-hidden="true">↗</span></a></article>';
}
module.exports = { renderFeatureCard, escapeHtml };
