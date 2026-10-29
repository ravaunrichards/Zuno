# Security policy

## Reporting a vulnerability

Please do not publish sensitive details in a public issue. Contact the repository owner through the private security-reporting channel configured for this repository.

## Security expectations

- Never commit passwords, tokens, service-role keys, certificates or production data.
- Sensitive operations must require trusted authentication and server-side role/ownership checks.
- Supabase Row Level Security must be enabled and tested for every client-accessible table.
- Ledger writes, payout operations, provider webhooks and audit records are server-managed.
- Verify provider webhook signatures, enforce idempotency and reconcile provider state before changing financial balances.
- Treat uploads, user text, URLs, search input and external provider payloads as untrusted.
- Security-sensitive configuration changes require tests and a documented rollback plan.
