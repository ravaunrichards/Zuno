-- ZUNO DEVELOPMENT seed — clearly non-production data.
-- NEVER run against production. No fake payments, payouts or engagement stats.
-- Usernames are prefixed 'dev_' so they are unmistakably test accounts.

insert into wallet_accounts (id, profile_id, kind)
  values ('00000000-0000-0000-0000-000000000001', null, 'mint'),
         ('00000000-0000-0000-0000-000000000002', null, 'sink')
  on conflict do nothing;

-- Gift definitions are loaded from assets/manifests/gift-manifest.json by
-- scripts/seed-gifts.js (so the catalog stays the single source of truth).
-- This file seeds only the structural dev fixtures above.
