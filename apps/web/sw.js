'use strict';
const CACHE = 'zuno-shell-v2';
const SHELL = ['./index.html','./runtime-config.js','./app.js','./manifest.webmanifest','./gifts.json','./src/styles/main.css','./src/styles/tokens.css','./src/styles/layout.css','./src/styles/components.css','./src/styles/responsive.css','./src/services/api-client.js','./src/components/navigation.js','./src/features/search/search.js','./src/features/creation/composer.js','./src/features/auth/session.js','./src/features/auth/wallet.js','./src/features/communities/communities.js','./src/features/marketplace/marketplace.js','./src/features/messaging.js','./src/features/subscriptions/subscriptions.js','./src/features/gifts/catalog.js','./src/features/livestreaming/live-preview.js','./src/features/livestreaming/live-room.js','./src/features/actions.js','./src/features/auth/session.js','./src/features/auth/auth-ui.js','./src/features/feed/feed.js','./icons/zuno-mark.svg'];
self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))); self.clients.claim(); });
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => {
    if (cached) return cached;
    return fetch(event.request).then((response) => {
      if (response.ok && response.type === 'basic') { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(event.request, copy)); }
      return response;
    }).catch(() => caches.match('./index.html'));
  }));
});
