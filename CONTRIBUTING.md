# Contributing to ZUNO

## Before changing code

Read the root README, the repository map, platform matrix and relevant feature/integration docs. Keep the canonical top-level structure stable and place files in the owning domain directory.

## Required checks

Run the relevant tests plus `pnpm lint`, `pnpm db:validate`, `pnpm assets:validate` and `pnpm build`. Report any check that cannot run instead of omitting it.

## Code standards

- Keep inputs validated and errors explicit.
- Use server-side authorization for every private or financial action.
- Never log secrets or commit credentials.
- Add migrations for schema changes and RLS tests for exposed tables.
- Include accessible labels, focus states and reduced-motion support in UI changes.
- Avoid duplicated implementations, empty placeholder files and misleading mock activity.
- Document new environment variables and unavailable provider behavior.

## Pull requests

Describe changed domains, migration order, test evidence, provider/toolchain limitations, and any security or financial implications. Do not state that a payment, LIVE flow, native app or deployment works unless it has been verified.
