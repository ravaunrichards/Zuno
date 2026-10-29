# ZUNO implementation register

This file differentiates committed code from production-verified capability. A source file or static check alone does not prove that an integration works end to end.

## Implemented in this branch

- A substantially richer responsive ZUNO web/PWA homepage and feature navigation, including Supabase sign-in, data-backed feed, text publication and creator media upload/processing UI.
- Shared frontend shell, feature cards, navigation configuration and visual theme primitives.
- Seven application directories with platform-specific starting implementations; native release builds still need platform CI evidence.
- API gift-catalogue endpoint, database-backed Z Coins package catalogue, protected wallet balance/restriction view and non-secret integration-readiness endpoint.
- Supabase Auth session validation and server-side profile lookup for sensitive API routes.
- LiveKit token authorization using verified identity, room ownership/participant membership and server-derived publishing capability.
- Authenticated gift delivery and PayPal order, capture and refund routes use database transaction functions and idempotency keys. PayPal webhook signatures are verified before an event is allowed to update payment state; provider uncertainty stays pending rather than being called paid. Production payment switching remains gated.
- Full-refund reservation and finalization SQL tracks coin debit/release; verified external reversals can create wallet restrictions pending reconciliation.
- Versioned SQL migrations `0001`–`0017` cover core schema/policies, content/discovery, messaging/calls, communities/events, LIVE interactions, creator economy/payment metadata, commerce/ads/privacy, operational jobs, media processing, transactional coin/gift/payment/refund functions, LIVE lifecycle, creator analytics and moderation/admin overview.
- Static migration, asset, web, platform-entrypoint and CI checks. Latest recorded CI at `41ee1320e7a4734670493485ae0576f52836e678`: 77 tests passed; 10/10 web checks passed; PostgreSQL 16 clean database applied migrations `0001`–`0017`, then passed RLS, gift/capture/refund ledger and moderation/audit smoke checks. Android build, security and accessibility/bundle-budget workflows passed on that head.

## Not yet production-verified

- Applying the migration chain to a real disposable PostgreSQL/Supabase project and running its actual Storage/Auth policies remain unverified. CI does pass the migration chain and RLS/economy/moderation smoke tests on disposable PostgreSQL 16.
- Full Supabase signup/provisioning, storage upload policies, profile settings, deletion/export processing and privacy workflows.
- LiveKit room lifecycle APIs, server-side signed webhook receiver and web UI are implemented, but deployed-provider webhook reconciliation and concurrent guest capacity must still be tested against a LiveKit sandbox.
- Transactional gift delivery, atomic capture-credit, full-refund reservation/finalization, provider-webhook handling and coin-package pricing are implemented and exercised in synthetic PostgreSQL smoke tests. Actual PayPal sandbox account/payment/refund/webhook evidence and production reconciliation remain outstanding. Creator earnings cash conversion remains unavailable until a real conversion policy is configured.
- Payout execution and country/account eligibility, which must remain disabled until provider and compliance readiness are proven.
- Server-side private signed upload URLs, metadata/size checks, byte-signature validation, queueing, media processing and creator upload UI are implemented; production Supabase Storage policies/configuration, antivirus scanning and derivative-path behavior still require provider validation.
- Durable production queue workers, search index, recommendation evaluation, actual push/email delivery, advertising delivery and marketplace order fulfillment.
- Desktop/TV release packaging, app-wide cross-platform feature parity and external provider sandbox tests still need direct end-to-end evidence. Android build passed on `41ee1320e7a4734670493485ae0576f52836e678`; current iOS workflow was queued at the time of the last status check, so no result is claimed here.
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
