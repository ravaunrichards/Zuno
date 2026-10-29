# Shared frontend layer

This folder contains provider-neutral layout, navigation, page registry and theme primitives shared by the platform design. Product domain behavior belongs under the appropriate `apps/<client>/src/features/` or shared `packages/` workspace; avoid copying the same business logic into multiple clients.
