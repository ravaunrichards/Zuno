# Provider readiness checklist

## Supabase
- [ ] Verify project URL and server-only credentials.
- [x] Apply migrations 0001–0029 to disposable PostgreSQL 16 in GitHub Actions.
- [x] Test positive/negative RLS access plus synthetic gift, capture-credit, refund-release/finalization and moderation/audit transitions in CI.
- [ ] Apply to an actual disposable Supabase project and verify Supabase-specific Auth, Storage and Realtime behavior.
- [ ] Verify private storage bucket policies.
- [x] Derive API profile identity from provider-verified Supabase access tokens, not client-supplied profile IDs.

## LiveKit
- [x] Authenticate callers before issuing room tokens.
- [x] Verify room host/guest permissions, short token expiry and least-privilege grants in source and unit/CI tests.
- [x] Implement signed webhook verification and idempotent room event records in source; unit test rejects missing/forged signatures.
- [ ] Verify webhooks against a configured LiveKit sandbox and test concurrent participant-capacity enforcement.

## PayPal Developer
- [ ] Verify sandbox create/approve/capture/refund with an actual PayPal test account.
- [x] Verify webhook signatures before ledger credit in source; invalid attempts are not stored as trusted canonical events.
- [x] Exercise duplicate capture-credit idempotency in PostgreSQL CI.
- [ ] Verify real provider webhook delivery, refunds, reversals and reconciliation end to end.
- [ ] Keep production payments and payouts disabled until reviewed.

## Creator PayPal Payouts
- [x] Encrypt recipient addresses at rest with server-only AES-256-GCM key.
- [x] Finance/admin review gates recipient, country eligibility, identity, compliance and risk hold.
- [x] Reserve available creator earnings atomically and idempotently before provider dispatch.
- [x] PayPal Payouts requests use a stable sender batch ID; uncertain provider outcomes keep earnings reserved.
- [x] A verified item-success webhook is required to mark earnings paid; definitive failures release reservations.
- [ ] Verify sandbox payout recipient onboarding, batch status/item webhooks and account-country eligibility with real PayPal Developer credentials.
- [ ] Production dispatch remains disabled until finance, provider and compliance sign-off.

## Marketplace fulfillment
- [x] Seller-authorized fulfillment state changes are mediated by a service-role-only transaction function.
- [x] Buyer and seller read policies expose only their own shipment/tracking records.
- [ ] Configure any shipping-carrier API only after choosing a supported carrier and account; current tracking numbers are seller-entered and not provider-verified.

## Render
- [ ] Bind the app to the provided service port.
- [ ] Configure required environment variables in the service dashboard.
- [ ] Redact secrets and sensitive user/payment data in logs.
- [ ] Deploy only after explicit authorization; configuration files do not imply a deployment. No deployment was performed as part of repository work.
