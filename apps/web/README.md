# ZUNO Web / PWA

The responsive homepage is a feature-rich gateway to discovery, LIVE formats, communities, Creator Studio and the bundled gift catalogue.

## Source ownership

- `index.html`: accessible semantic application shell.
- `src/styles/`: tokens, layouts, components and responsive behavior.
- `src/components/navigation.js`: navigation and active-section coordination.
- `src/features/`: feature-scoped interactions.
- `src/services/api-client.js`: timed JSON API client.
- `app.js`: client initialization.
- `sw.js`: offline cache for local shell assets.

Local draft actions save only in the current browser. The gift section reads the bundled catalogue or real catalogue endpoint; it does not send gifts or spend Z Coins. LIVE status is not shown as active unless the service returns room data. This client still needs authenticated feed, profile, messaging, uploads and payment APIs before those features can be marked production-connected.
