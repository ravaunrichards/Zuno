# Security and financial integrity

## Z Coins
The server-side ledger is authoritative. A client cannot supply an amount to credit, modify ledger postings or determine payout eligibility.

## PayPal lifecycle
A payment flow needs server-side order creation, verified provider capture, signed webhook verification, durable event idempotency, atomic coin credit, reconciliation and auditable refund/reversal handling. A browser return or successful order creation is not enough to credit coins.

## Creator earnings
A versioned policy defines the initial creator/platform split, treatment of provider fees, refunds and reversals. Keep payout initiation disabled until provider access, recipient eligibility, legal/business requirements and verified webhook state are in place.

## LiveKit
Room tokens are server-issued with short expiry and least-privilege permissions. Authenticate callers, verify host/viewer/guest permissions, enforce capacity and verify signed webhooks before changing persistent room state.

## Data access
Use row-level security on exposed tables and server-only writes for financial, moderation and audit operations. Logs must not contain passwords, provider secrets, tokens or full payment credentials.
