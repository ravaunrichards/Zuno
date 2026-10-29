# ZUNO

**ZUNO** is an independent, multi-platform social, entertainment, communication and creator ecosystem. The repository is organized as a pnpm/Turborepo-style workspace with separate applications, backend services, shared packages, database migrations, integrations, assets, infrastructure, tests and verification tools.

> **Current status: PARTIALLY IMPLEMENTED.** This branch establishes the rich web experience, application foundations, API safety boundaries, domain-policy modules and a versioned database migration chain. It is not yet a completed production product. Several provider-connected flows are deliberately disabled until their persistent transactional implementation and end-to-end verification are complete.

## Repository map

- `apps/`: Web/PWA, Android, iOS, Desktop, TV, Admin and Creator Studio.
- `backend/`: API, realtime, media processing, notifications, payments, payouts, recommendations, moderation, search and worker services.
- `frontend/`: shared page shell, navigation, reusable components and theme primitives.
- `database/migrations/`: the canonical ordered SQL schema and policy history.
- `integrations/`: Supabase, LiveKit, PayPal Developer and external service adapters.
- `packages/`: shared design system, API contracts, validation, auth, database, payment, media and gift primitives.
- `assets/`: original visual, audio, animation and 3D resources plus manifests.
- `infrastructure/`: local container, Render, deployment and monitoring definitions.
- `tests/`: unit, integration, accessibility, security, performance and cross-platform checks.
- `.github/workflows/`: CI and platform/security workflows.

## Local development

Prerequisites: Node.js 20 or later and Corepack/pnpm. PostgreSQL/Supabase, LiveKit and PayPal credentials are only required for their corresponding integration paths.

```bash
corepack enable
pnpm install --no-frozen-lockfile
pnpm run typecheck
pnpm run platforms:validate
pnpm run validate:assets
pnpm run validate:db
pnpm run test
pnpm run build:web
```

Review `.env.example` before configuring local services. Never commit actual keys or production data. Database changes must be applied in numeric order to a disposable PostgreSQL/Supabase project before a shared environment.

## Safety and production readiness

- Authentication-sensitive endpoints require a provider-verified Supabase session and a provisioned ZUNO profile.
- LiveKit publish permission is determined server-side from room ownership or participant role, not the request body.
- Gift sending and checkout currently return an explicit not-ready response until atomic persistent delivery/payment lifecycle handling is connected. No demo balance or fake payment is represented as production.
- Payouts remain gated until recipient eligibility, compliance, provider readiness and reconciliation have been verified.
- A configured environment value is not proof that a provider call or deployment works.
- The current deterministic recommendation code is a baseline, not a machine-learned system. Metadata validation is not file-signature validation or transcoding.

## Product direction

ZUNO is intended to combine social networking, video and photo publishing, discovery, messaging and calls, communities, events, livestreaming, original 3D gifts and audio, Z Coins, subscriptions, creator monetization, commerce, ads, moderation, privacy and administrative tools into one coordinated experience. Each capability must have real implementation, schema/policies where persistent, tests and documentation.

See `docs/status/implementation-register.md`, `docs/architecture/repository-map.md`, `docs/database/migrations.md`, and `docs/integrations/provider-readiness.md`.
