# Payouts service

`src/eligibility.js` is an eligibility gate, not a payout executor. Actual payouts require recipient readiness, country/provider eligibility, compliance checks, available earnings, provider idempotency and reconciliation. Keep payouts disabled until verified.
