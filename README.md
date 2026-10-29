# ZUNO

**Unified global social, entertainment, communication, livestreaming, commerce and creator ecosystem.**

ZUNO is being developed as one connected platform across web, Android, iOS, desktop, TV, administration and Creator Studio. Its product scope includes social publishing and discovery, video and audio, messaging and calls, communities and events, LIVE experiences, original virtual gifts, Z Coins, creator monetization, commerce, ads and platform operations.

## Product principles

- A rich, useful homepage—not a thin landing page or gift-only catalogue.
- One coherent account, shared design language and common API contracts across applications.
- Real functionality, persistent data and server-authoritative financial state; no pretend payments, live attendance, gifts or payouts.
- Explicit capability status when a provider, credential or deployment is not configured.
- Comprehensive ordered migrations, least-privilege authorization, auditability and repeatable verification.
- Honest reporting: visual previews and local drafts must never be described as production-backed features.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/` | Platform clients: web, Android, iOS, desktop, TV, admin and Creator Studio |
| `backend/` | API, realtime, media processing, notifications, payments, payouts, recommendations, moderation, search and workers |
| `frontend/` | Reusable frontend elements, layouts, navigation, page registry and themes |
| `assets/` | Original visual assets, gift assets, 3D geometry, audio and manifests |
| `config/` | Validated runtime configuration and feature gates |
| `database/` | Ordered PostgreSQL migrations, policies, functions, schemas and seed data |
| `integrations/` | Supabase, LiveKit, PayPal Developer and external-service adapters |
| `packages/` | Shared UI, design system, API contracts, validation, auth, database, payments, media, gift engine and utilities |
| `infrastructure/` | Docker, Render, deployment and monitoring |
| `localization/` | Locale dictionaries and translation utilities |
| `models/` | Typed domain and event models |
| `scripts/` and `tools/` | Build, test, packaging, validation and development tooling |
| `tests/` | Unit, integration, end-to-end, security, accessibility, performance, payments and cross-platform tests |
| `.github/` | Continuous integration, templates and repository security guidance |
| `docs/` and `verification/` | Architecture, operation, integration setup, evidence and outstanding work |

The canonical root structure is kept intact. Domain code belongs in a clearly named subfolder; shared behavior should not be copied into each client.

## Local development

Requirements: Node.js 20 or newer and pnpm. Install dependencies with `pnpm install`, copy `.env.example` to `.env`, then run:

```sh
pnpm dev
pnpm test
pnpm lint
pnpm assets:validate
pnpm db:validate
pnpm build
pnpm verify
```

The static web client can be served by any static HTTP server from `apps/web/`. The API listens on `127.0.0.1:4000` in local development. Do not expose service-role keys or provider secrets to client applications.

## Provider setup

- **Supabase:** create/configure the project and apply every ordered migration in `database/migrations/`. See [database setup](docs/database/migrations.md).
- **LiveKit:** configure server-only room credentials and webhook verification before enabling live-room actions.
- **PayPal Developer:** use sandbox credentials first. Payment creation, capture, webhook verification, idempotency and reconciliation must pass before enabling production payment flags.
- **Render:** use the configuration in `infrastructure/render/`; do not deploy without explicit authorization and production readiness review.

Missing provider settings must produce a clear unavailable response. Local UI previews and tests are not proof of provider connectivity.

## Current implementation status

This repository is an actively evolving codebase. Read [the platform matrix](docs/platforms.md) and [implementation status](docs/implementation/status.md) before assuming a feature or deployment is complete. A source file, configuration, or UI surface alone does not establish a working production integration.
