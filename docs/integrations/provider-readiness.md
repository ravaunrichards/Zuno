# Provider readiness checklist

## Supabase
- [ ] Verify project URL and server-only credentials.
- [ ] Apply the ordered migration chain to a disposable database.
- [ ] Test both permitted and denied RLS access.
- [ ] Verify private storage bucket policies.
- [ ] Derive profile identity from a trusted provider-verified JWT, not a client-supplied profile ID.

## LiveKit
- [ ] Authenticate callers before issuing room tokens.
- [ ] Verify room host/guest permissions, short token expiry and least-privilege grants.
- [ ] Verify signed webhooks and idempotent room lifecycle records.
- [ ] Test concurrent participant-capacity enforcement.

## PayPal Developer
- [ ] Verify sandbox create/approve/capture with an actual test account.
- [ ] Verify webhook signatures before ledger credit.
- [ ] Prove duplicate webhook delivery cannot double-credit.
- [ ] Verify refunds, reversals and reconciliation.
- [ ] Keep production payments and payouts disabled until reviewed.

## Render
- [ ] Bind the app to the provided service port.
- [ ] Configure required environment variables in the service dashboard.
- [ ] Redact secrets and sensitive user/payment data in logs.
- [ ] Deploy only after explicit authorization; configuration files do not imply a deployment.
