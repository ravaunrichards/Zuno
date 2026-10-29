'use strict';
// ZUNO PWA shell logic. CSP-safe: no inline handlers, same-origin assets only.
// Loads the gift catalog from the packaged manifest and pings the API /health.
(function () {
  var API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000' : '';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderGifts(gifts) {
    var grid = document.getElementById('gifts');
    document.getElementById('count').textContent = '(' + gifts.length + ' gifts)';
    grid.innerHTML = '';
    gifts.slice(0, 120).forEach(function (g) {
      var el = document.createElement('div');
      el.className = 'card';
      el.innerHTML =
        '<div class="name">' + esc(g.name) + '</div>' +
        '<div class="cat">' + esc(g.categoryLabel || g.category) + '</div>' +
        '<div class="price">\u25C9 ' + esc(g.priceCoins) + '</div>' +
        '<span class="badge">tier ' + esc(g.tier) + ' \u00B7 ' + esc(g.fx) + '</span>';
      grid.appendChild(el);
    });
  }

  // Catalog is bundled with the app for offline-first display.
  fetch('./gifts.json').then(function (r) { return r.json(); })
    .then(renderGifts)
    .catch(function () { document.getElementById('gifts').innerHTML = '<div class="status">Could not load catalog.</div>'; });

  fetch(API + '/health').then(function (r) { return r.json(); })
    .then(function (h) { document.getElementById('health').textContent = 'API: ' + h.status; })
    .catch(function () { document.getElementById('health').textContent = 'API offline'; });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(function () {});
})();
