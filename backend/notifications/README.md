# ZUNO notification worker

The outbox dispatcher claims events using the service-role-only PostgreSQL RPC, turns supported social, LIVE, gifting and creator-membership events into idempotent in-app notifications, and records in-app delivery through the database trigger. Unknown events are acknowledged without inventing a notification. Database/provider errors trigger retry with capped backoff and eventual dead-lettering.

Required runtime configuration: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Run with `pnpm --filter @zuno/backend-notifications start`. The worker does not claim that external push or email delivery occurred; those transports are separate and must be configured before enabled.
