# ZUNO

**ZUNO** is an independent, multi-platform social, entertainment, communication and creator ecosystem. The repository is organized as a pnpm/Turborepo-style workspace with separate applications, backend services, shared packages, database migrations, integrations, assets, infrastructure, tests and verification tools.

> **Current status: PARTIALLY IMPLEMENTED — ZUNO is not production-ready.** `main` currently points to merge commit `f894c66d0d258f765df12f7b91396ff073a9e34e` (2026-10-29). Historical CI notes in this repository refer to earlier commits and do not prove that this merged commit passes CI. No status contexts were returned for the merge SHA in this audit, and the available workflow-run lookup did not confirm a current run, so CI for this exact commit remains **unverified here** (this is not a claim that CI failed). The database validator expects migrations `0001`–`0032`. External-provider sandbox tests, native platform builds, and production deployment verification remain outstanding until supported by fresh, commit-specific evidence.

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
pnpm run lint
pnpm run platforms:validate
pnpm run assets:validate
pnpm run db:validate
pnpm run test
pnpm run build:web
pnpm run build:apps
pnpm run verify
```

`typecheck`, `validate:assets`, and `validate:db` are not root scripts in the current `package.json`; use the listed commands above. Run `pnpm run db:test` only after setting `DATABASE_URL` to a **disposable PostgreSQL database**, never to production.

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

The test counts recorded in older reports are historical and must not be treated as verification of the current merge commit. Review the [GitHub Actions runs](https://github.com/ravaunrichards/Zuno/actions) and confirm the exact commit SHA before recording any result as passed. Provider sandbox and production verification are separate requirements even when CI is green.

See `docs/status/implementation-register.md`, `docs/architecture/repository-map.md`, `docs/database/migrations.md`, `docs/integrations/provider-readiness.md`, and `docs/deployment/render.md`.


### Multi-app local previews

The development preview commands serve the shared `dist/` root so each app's links to the web client resolve correctly. Run `pnpm serve:web` and open `http://127.0.0.1:3000/`; admin uses port 3002 at `/admin/index.html`, Creator Studio uses port 3003 at `/creator-studio/index.html`, and TV uses port 3004 at `/tv/index.html`. Configure `ZUNO_PUBLIC_API_BASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and optionally `ZUNO_PUBLIC_WEB_BASE_URL` to enable connected provider workflows. Camera and microphone permissions are allowed only for same-origin web pages by the local static server.
