'use strict';

/** Resolve cross-app links for shared-origin deployment or a configured public web origin. */
export function mountProductLinks() {
  const config = window.ZUNO_CONFIG || {};
  const raw = typeof config.webBaseUrl === 'string' && config.webBaseUrl.trim()
    ? config.webBaseUrl.trim() : '../web/index.html';
  let base;
  try {
    base = new URL(raw, document.baseURI);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) return;
  } catch (_) { return; }
  document.querySelectorAll('a[href="../web/index.html"],a[href^="../web/index.html#"]').forEach((link) => {
    let hash = '';
    try { hash = new URL(link.getAttribute('href'), document.baseURI).hash; } catch (_) {}
    const destination = new URL(base.toString());
    if (!destination.hash && hash) destination.hash = hash;
    link.href = destination.toString();
  });
}
