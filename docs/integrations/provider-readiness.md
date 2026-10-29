# Provider readiness checklist

## Supabase
- [ ] Verify project URL and server-only credentials.
- [x] Apply migrations 0001–0026 to disposable PostgreSQL 16 in GitHub Actions.
- [x] Test positive/negative RLS access plus synthetic gift, capture-credit, refund-release/finalization and moderation/audit transitions in CI.
- [ ] Apply to an actual disposable Supabase project and verify Supabase-specific Auth, Storage and Realtime behavior.
- [ ] Verify private storage bucket policies.
- [ ] Derive profile identity from a trusted provider-verified JWT, not a client-supplied profile ID.

## LiveKit
- [ ] Authenticate callers before issuing room tokens.
- [ ] Verify room host/guest permissions, short token expiry and least-privilege grants.
- [x] Implement signed webhook verification and idempotent room event records in source; unit test rejects missing/forged signatures.
- [ ] Verify webhooks against a configured LiveKit sandbox and test concurrent participant-capacity enforcement.

## PayPal Developer
- [ ] Verify sandbox create/approve/capture/refund with an actual PayPal test account.
- [x] Verify webhook signatures before ledger credit in source; invalid attempts are not stored as trusted canonical events.
- [x] Exercise duplicate capture-credit idempotency in PostgreSQL CI.
- [ ] Verify real provider webhook delivery, refunds, reversals and reconciliation end to end.
- [ ] Keep production payments and payouts disabled until reviewed.

## Render
- [ ] Bind the app to the provided service port.
- [ ] Configure required environment variables in the service dashboard.
- [ ] Redact secrets and sensitive user/payment data in logs.
- [ ] Deploy only after explicit authorization; configuration files do not imply a deployment. No deployment was performed as part of repository work.
