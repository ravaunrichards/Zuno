# Database migration workflow

The canonical schema-change history is `database/migrations/NNNN_*.sql`. Apply files in numeric order to a disposable PostgreSQL/Supabase database before shared environments.

1. Back up data and test recovery before destructive changes.
2. Never edit an applied migration; add the next migration.
3. Keep constraints, indexes and row-level security policy changes in ordered migration files.
4. Client roles must not write ledger postings, payment webhook records, payout reconciliation or audit records.
5. Webhook processing and ledger effects must be idempotent and reconcilable.
6. Static checks are not proof that SQL executed successfully; run the chain against an actual database.

Seeds are environment-scoped. Development records must not mimic real users, engagements, purchases or payouts. Secrets never belong in SQL migrations.


## Migrations 0018–0026 (2026-10-29)

The current ordered chain continues after 0017 with conversation/community transaction controls (0018), marketplace inventory and order lifecycle (0019), creator subscription provider lifecycle (0020), privacy data-rights and notification history (0021), message/call lifecycle mutations (0022), atomic social relationship controls (0023), feed interaction idempotency (0024), notification outbox and push subscriptions (0025), and retryable notification delivery with quiet-hours timezone handling (0026). The 26-migration chain passed the repository's clean PostgreSQL 16 CI workflow at commit `92bc0412a7595dc984dc600c7f2d3cf3a9659be1` on 2026-10-29. Production Supabase Auth/Storage policies and actual external push/email delivery are still separate verification items.


## 0031–0032: Creator payout dispatch and recipient snapshot

`0031_creator_payouts_and_provider_reconciliation.sql` provides the encrypted destination profile, finance review gates and atomic payout reservation/completion/release functions. `0032_payout_recipient_snapshot.sql` freezes the encrypted recipient on the payout row itself. Provider retries therefore use the destination that was reserved with the earnings, not whichever email is currently configured on the creator profile.
