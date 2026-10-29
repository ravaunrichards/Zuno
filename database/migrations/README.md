# Migration execution

The numbered files in this folder are the canonical PostgreSQL schema history. Run `pnpm db:validate` for static checks and `pnpm db:test` only against a disposable PostgreSQL database to apply every migration from scratch and run RLS smoke checks.

`scripts/test-migrations.sh` creates a minimal local Supabase-compatible `auth.uid()` function and roles for CI. This validates PostgreSQL syntax, object dependencies and selected row-level security behavior. It is not a substitute for applying the same chain in the actual Supabase project or testing provider webhooks and storage policies there.

Never point the smoke-test script at production.
