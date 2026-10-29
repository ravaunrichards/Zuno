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
- Versioned SQL migrations `0001`–`0026` cover core schema/policies, content/discovery, messaging/calls, communities/events, LIVE interactions, creator economy/payments, commerce/ads/privacy, operational jobs, media processing, atomic gift/capture/refund functions, LIVE lifecycle, creator analytics, moderation/admin overview, message/call lifecycle, atomic social relationship controls, feed interaction idempotency, notification outbox/push subscriptions and retryable delivery with profile timezones.
- Static migration, asset, web, platform-entrypoint and CI checks. Latest inspected CI on `92bc0412a7595dc984dc600c7f2d3cf3a9659be1` (2026-10-29): 117 automated tests passed; 10/10 web checks passed; the PostgreSQL 16 clean-database workflow applied all 26 migrations and passed RLS, economy, moderation, messaging, community and call smoke checks. Security and accessibility/bundle-budget workflows passed on that head. Android was in progress and iOS queued at the time of this inspection; later platform status is linked from the Actions page.

## Not yet production-verified

- Applying the migration chain to a real disposable PostgreSQL/Supabase project and running its actual Storage/Auth policies remain unverified. CI does pass the migration chain and RLS/economy/moderation smoke tests on disposable PostgreSQL 16.
- Full Supabase signup/provisioning, storage upload policies, profile settings, deletion/export processing and privacy workflows.
- LiveKit room lifecycle APIs, signed webhook receiver and web UI are in the repository. Clean-source CI covers the adapter’s missing/forged signature cases, but deployed-provider webhook reconciliation, real audio/video tracks and concurrent guest capacity still require a LiveKit sandbox test.
- Transactional gift delivery, atomic capture-credit, full-refund reservation/finalization, provider-webhook handling and coin-package pricing are implemented and exercised in synthetic PostgreSQL smoke tests. Actual PayPal sandbox account/payment/refund/webhook evidence and production reconciliation remain outstanding. Creator earnings cash conversion remains unavailable until a real conversion policy is configured.
- Payout execution and country/account eligibility, which must remain disabled until provider and compliance readiness are proven.
- Server-side private signed upload URLs, metadata/size checks, byte-signature validation, queueing, media processing and creator upload UI are implemented; production Supabase Storage policies/configuration, antivirus scanning and derivative-path behavior still require provider validation.
- Durable production queue workers, search index, recommendation evaluation, actual push/email delivery, advertising delivery and marketplace order fulfillment.
- Desktop/TV release packaging, app-wide cross-platform feature parity and external provider sandbox tests still need direct end-to-end evidence. Android and iOS status must be read from the most recent workflow runs; this register does not claim a release artifact or device-level validation without a completed green build.
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


## Gift audio inventory — 2026-10-29

The manifest contains 103 stable gift IDs. 57 have an audio file with a matching SHA-256 checksum. The remaining 46 entries are marked `unresolved` with an explicit reason and no audio path; they are not represented by generic substitute sounds. A gift can be called audio-complete only when its authored effect exists, is mapped to the correct ID, and validates against the manifest.


## Additional migrations 0018–0026

- `0018_conversation_and_community_transactions.sql`: database-backed conversation/community transaction boundaries and membership/content controls.
- `0019_marketplace_inventory_and_orders.sql`: inventory constraints and transactional order mutations.
- `0020_creator_subscription_provider_lifecycle.sql`: creator membership and provider lifecycle state.
- `0021_privacy_data_rights_and_notification_history.sql`: profile data-rights workflow, consent and notification history.
- `0022_messaging_call_lifecycle_and_message_mutations.sql`: message mutation restrictions and persisted call lifecycle.
- `0023_atomic_social_relationship_controls.sql`: atomic follows, blocks, mutes and restrictions.
- `0024_feed_interaction_idempotency.sql`: request idempotency for feed reactions, reposts, bookmarks and views.
- `0025_notification_outbox_delivery_and_push.sql`: server-generated notification outbox events, in-app delivery, and push-subscription policy.
- `0026_notification_channel_retry_queue.sql`: retry scheduling/claim metadata, and per-profile timezone handling for quiet hours.

These additions passed the clean PostgreSQL 16 migration and core smoke workflow on the inspected head. Email/push provider delivery and production Supabase policy behavior remain environment-dependent and are not claimed as verified by that workflow.


## Privacy export processing update

Migration `0027_privacy_data_export_processing.sql` adds a service-role-only claim/finish lease for export jobs. The worker creates a JSON export of account, social, content, messaging, community, LIVE, wallet, creator, commerce, moderation, consent and notification records in private Supabase Storage. It redacts credential-like fields and signed URL query credentials, paginates database reads, caps each export at 50,000 rows/100 MiB and expires the result after 7 days. The owner can request a short-lived signed download URL from the API. Deletion/correction/restriction requests remain visibly pending review; they are not silently declared complete by the export worker.
