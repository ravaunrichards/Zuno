#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${DATABASE_URL:?DATABASE_URL must point at a disposable PostgreSQL database}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'CREATE ROLE anon NOLOGIN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'CREATE ROLE authenticated NOLOGIN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE ROLE service_role NOLOGIN BYPASSRLS'; END IF;
END
$bootstrap$;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $uid$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$uid$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;
SQL

for migration in "$ROOT"/database/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  echo "Applying $(basename "$migration")"
  psql "$DATABASE_URL" --set ON_ERROR_STOP=1 --single-transaction --file "$migration"
done

for seed in "$ROOT"/database/seeds/[0-9][0-9][0-9][0-9]_*.sql; do
  [ -f "$seed" ] || continue
  echo "Applying development/reference seed $(basename "$seed")"
  psql "$DATABASE_URL" --set ON_ERROR_STOP=1 --single-transaction --file "$seed"
done

psql "$DATABASE_URL" --set ON_ERROR_STOP=1 --single-transaction --file "$ROOT/tests/database/rls-smoke.sql"
