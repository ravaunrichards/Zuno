# Payments service

`src/order-policy.js` defines request validation and legal recharge state transitions. It does not call PayPal or credit a wallet. Credit requires verified provider capture/webhooks, durable idempotency, atomic ledger postings and reconciliation.
