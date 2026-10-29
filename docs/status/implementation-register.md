# ZUNO implementation register

This file differentiates committed code from production-verified capability. A source file or static check alone does not prove that an integration works end to end.

## Implemented in this branch

- A substantially richer responsive ZUNO web/PWA homepage and feature navigation.
- Shared frontend shell, feature cards, navigation configuration and visual theme primitives.
- Seven application directories with platform-specific starting implementations; native release builds still need platform CI evidence.
- API gift-catalogue endpoint and non-secret integration-readiness endpoint.
- Supabase Auth session validation and server-side profile lookup for sensitive API routes.
- LiveKit token authorization using verified identity, room ownership/participant membership and server-derived publishing capability.
- Authenticated gift delivery and PayPal checkout/capture routes use database transaction functions, idempotency keys and signed provider webhooks; production payment switching remains gated by environment readiness.
- Full-refund reservation and finalize SQL tracks coin debit/release, with wallet restrictions for unreconciled external reversals.
- Versioned SQL migrations for core schema/policies, content/discovery, messaging/calls, communities/events, LIVE interactions, creator economy/payment metadata, commerce/ads/privacy, and operational jobs.
- Static migration, asset, web, platform-entrypoint and CI checks.

## Not yet production-verified

- Applying the migration chain to a real disposable PostgreSQL/Supabase database and running positive/negative RLS tests.
- Full Supabase signup/provisioning, storage upload policies, profile settings, deletion/export processing and privacy workflows.
- LiveKit room creation/lifecycle and signed webhook reconciliation, plus race-safe participant-capacity enforcement.
- Transactional gift delivery, sandbox/provider credentials, refund provider execution and end-to-end PayPal reconciliation still require external test-account evidence. Creator earnings cash conversion remains intentionally unavailable until a real conversion policy is configured.
- Payout execution and country/account eligibility, which must remain disabled until provider and compliance readiness are proven.
- Server-side media upload, byte validation, queueing and processing modules are implemented; production storage configuration, antivirus scanning and derivative-path behavior still require end-to-end provider validation.
- Durable production queue workers, search index, recommendation evaluation, actual push/email delivery, advertising delivery and marketplace order fulfillment.
- Desktop/TV/admin/creator release packaging and external provider sandbox tests still need direct end-to-end evidence. iOS and Android simulator/build CI passed on commit `ff370b6529b84d895f63f93cd3abd5f755379ee2`.
- Completed original 3D gift assets and every required distinct sound mapped against a validated manifest.

## Reporting standard

Record each test as **passed**, **failed**, **blocked**, or **not run** with its command and result. Do not infer production readiness from a configured environment variable, UI preview or static validation.


## Added progression policy in migration 0010

- Close-friends story visibility now has a private close-friend relation and owner-scoped management.
- The configurable gifter threshold table maps Level 0 to 0 and Level 50 to exactly 100,000,000 eligible lifetime coins; intermediate levels use a stored exponential threshold schedule.
- Eligible gift-delivery rows automatically refresh gifter progress and record Ultimate Universe at 1,000,000 eligible lifetime coins, separately from level milestones.
- Creator earning entries can record gross amount, provider fees, net amount, creator/platform shares, policy version, source idempotency and payout association under server-managed writes.
- These SQL definitions still require application to a real disposable PostgreSQL/Supabase database and transaction-level RLS/trigger tests before they can be treated as verified.


## Feed contract update

The API now accepts `offset` and `limit` for feed pagination. Following feeds use PostgREST range pagination under the current session's RLS. The deterministic For You baseline ranks the first 300 accessible candidates and pages the ranked results; this is an explicit bounded baseline rather than a claim of infinite-scale recommendation serving.
