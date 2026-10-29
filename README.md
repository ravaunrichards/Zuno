# ZUNO

**ZUNO** is an independent, multi-platform social, entertainment, communication and creator ecosystem. The repository is organized as a pnpm/Turborepo-style workspace with separate applications, backend services, shared packages, database migrations, integrations, assets, infrastructure, tests and verification tools.

> **Current status: PARTIALLY IMPLEMENTED — core backend flows are in the codebase, but the full product is not production-ready.** The current branch includes persisted gift delivery, PayPal checkout/capture/refund paths, verified webhook ingestion, private media upload/processing, LIVE room workflows, protected operations tooling, and migrations through `0017`. CI has exercised the ordered migration chain, RLS, wallet/gift/payment/refund transactions, moderation/audit transitions, the web build, and automated source tests. External-provider sandbox and production deployment verification remain outstanding.

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
pnpm run build:apps
```

Review `.env.example` before configuring local services. Never commit actual keys or production data. Database changes must be applied in numeric order to a disposable PostgreSQL/Supabase project before a shared environment.

## Safety and production readiness

- Authentication-sensitive endpoints require a provider-verified Supabase session and a provisioned ZUNO profile.
- LiveKit publish permission is determined server-side from room ownership or participant role, not the request body.
- Gift delivery and PayPal checkout/capture/refund use database transaction functions and provider verification. Actual coin credit requires verified capture reconciliation; a browser redirect by itself does not count as payment.
- Production payment and payout switches remain gated. Payouts remain disabled until recipient eligibility, compliance, provider readiness and reconciliation have been verified.
- Provider test accounts/credentials, real Supabase policies/storage, LiveKit webhooks in a deployed environment, and Render deployments still need external end-to-end verification.
- The current deterministic recommendation code is a bounded baseline, not a machine-learned system. Media byte-signature validation and processing exist, but production antivirus scanning, derivative publishing and storage policy checks still require provider-environment validation.

## Product direction

ZUNO is intended to combine social networking, video and photo publishing, discovery, messaging and calls, communities, events, livestreaming, original 3D gifts and audio, Z Coins, subscriptions, creator monetization, commerce, ads, moderation, privacy and administrative tools into one coordinated experience. Each capability must have real implementation, schema/policies where persistent, tests and documentation.

Latest documented CI evidence (commit `41ee1320e7a4734670493485ae0576f52836e678`, 2026-10-29): 77 automated tests passed, 10/10 web checks passed, and the disposable PostgreSQL 16 run successfully applied migrations `0001`–`0017` and passed RLS, economy and moderation smoke checks. Android build, security checks and web accessibility/bundle budget also passed on that commit. Check the current Actions page for results after later commits. These checks do not substitute for provider sandbox or production verification.

See `docs/status/implementation-register.md`, `docs/architecture/repository-map.md`, `docs/database/migrations.md`, and `docs/integrations/provider-readiness.md`.


### Multi-app local previews

The development preview commands serve the shared `dist/` root so each app's links to the web client resolve correctly. Run `pnpm serve:web` and open `http://127.0.0.1:3000/`; admin uses port 3002 at `/admin/index.html`, Creator Studio uses port 3003 at `/creator-studio/index.html`, and TV uses port 3004 at `/tv/index.html`. Configure `ZUNO_PUBLIC_API_BASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and optionally `ZUNO_PUBLIC_WEB_BASE_URL` to enable connected provider workflows. Camera and microphone permissions are allowed only for same-origin web pages by the local static server.
