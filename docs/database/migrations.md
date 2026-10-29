# Database migration workflow

The canonical schema-change history is `database/migrations/NNNN_*.sql`. Apply files in numeric order to a disposable PostgreSQL/Supabase database before shared environments.

1. Back up data and test recovery before destructive changes.
2. Never edit an applied migration; add the next migration.
3. Keep constraints, indexes and row-level security policy changes in ordered migration files.
4. Client roles must not write ledger postings, payment webhook records, payout reconciliation or audit records.
5. Webhook processing and ledger effects must be idempotent and reconcilable.
6. Static checks are not proof that SQL executed successfully; run the chain against an actual database.

Seeds are environment-scoped. Development records must not mimic real users, engagements, purchases or payouts. Secrets never belong in SQL migrations.
