# Security and financial integrity

## Z Coins and ledger

Z Coins are a platform-specific stored unit, not cash. The database ledger is authoritative. Client-visible balances are derived views; the client cannot supply the amount to credit, alter ledger postings or decide payout eligibility.

## PayPal lifecycle

A real payment lifecycle needs an order created server-side, an approved provider capture, verified signed webhook delivery, durable event idempotency, atomic coin credit, reconciliation and auditable refund/reversal handling. An order being created or a browser returning from checkout is not enough to credit coins.

## Creator earnings and payouts

Creator/platform shares are determined from a versioned server-side policy. A 50/50 starting split requires a defined policy version and a clear basis for fees, refunds and reversals. Payouts remain disabled until provider access, recipient eligibility, legal/business requirements and verified webhook state are configured.

## LiveKit

Room tokens are server-issued with the smallest required permissions and short expiry. A production route must authenticate the caller, verify room membership/host permissions and enforce the room capacity before minting credentials. Do not expose LiveKit API secrets or allow callers to choose privileged claims.

## Data access

Enable row-level security for exposed tables, explicitly scope policies to the current profile, and keep financial, moderation and audit operations server-managed. Test cross-user access denial as well as successful owner access. Logs must not include passwords, access tokens, service keys or full payment credentials.
