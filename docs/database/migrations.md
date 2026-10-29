# Database migrations and application order

The canonical schema-change history lives in `database/migrations/` and uses stable, ordered filenames. Apply the SQL in numeric order to a disposable development database first, verify policies and invariants, then apply it to managed environments through the approved deployment process.

## Operating rules

1. Back up production data and test rollback/recovery before applying destructive changes.
2. Do not modify an already-applied migration; create the next numbered migration.
3. Keep DDL, indexes, constraints and row-level security policies together in the ordered chain.
4. Client roles receive only the privileges needed for their actions. Wallet postings, provider webhooks, creator payouts and audit records must not be writable by ordinary client roles.
5. Keep financial events idempotent and reconcile provider state against server records.
6. Use real Supabase/PostgreSQL execution to verify SQL compatibility. Static checks are useful but are not proof that a migration has executed successfully.

## Existing domains

Identity and social graph, content, comments and reactions, messaging, communities/events, LIVE rooms, gift catalog, ledger accounts/postings, recharge orders, gifter progression, subscriptions, earnings, payouts, moderation, notifications, rankings and audit events are part of the schema. Follow-on migrations add the missing persistence domains without silently discarding existing data.

## Environments and secrets

Schema migrations do not contain provider credentials. Keep Supabase service-role keys and webhook secrets in server-side environment configuration only. Seed data must be explicitly marked as development/reference data and must never mint balances or impersonate real user activity.
