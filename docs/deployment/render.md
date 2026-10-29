# Render deployment plan

The root `render.yaml` is an infrastructure-as-code Blueprint for the existing pnpm workspace. It defines four services from this repository:

- `zuno-api`: Node API service with `/health` health checks.
- `zuno-web`: static web/PWA publishing the repository's `dist` output, including admin, Creator Studio and TV builds produced by `pnpm build:apps`.
- `zuno-notification-worker`: durable notification outbox and push/email delivery worker.
- `zuno-media-worker`: background media validation/processing worker.

## Safe initial state

All services have automatic deploys turned off in the Blueprint. Free plans are selected to avoid a paid resource being created by default; they are intended for smoke testing, not production traffic. The Blueprint does not create a second database: ZUNO uses the configured Supabase project.

No credentials, endpoints belonging to an existing account, or customer data are stored in this file. Values marked `sync: false` must be supplied through Render's dashboard during initial Blueprint creation. When syncing an existing Blueprint later, Render does not re-prompt for these variables; add or rotate them in the service settings.

## Required configuration

1. Configure the API's `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and the required Auth/JWT settings in the Supabase project.
2. Set `APP_BASE_URL` to the actual public web URL, and set `CORS_ALLOWED_ORIGINS` to that exact origin. Do not use a wildcard.
3. Set the static site's `ZUNO_PUBLIC_API_BASE_URL` to the actual API service URL, plus the Supabase URL, anonymous key and LiveKit public URL.
4. Configure LiveKit credentials and webhook settings before testing LIVE rooms.
5. Keep PayPal in sandbox mode and `FEATURE_PRODUCTION_PAYMENTS=false` until signed webhook delivery and reconciliation are demonstrated with the intended account. Payouts remain disabled.
6. Add VAPID/Resend keys only if external notification channels will be used. Blank or missing optional provider configuration must keep that channel explicitly unavailable.

## Deploy order and checks

Blueprint sync provisions/configures the services but the configuration is not proof of a successful provider integration. Before relying on it, configure the Supabase schema by applying migrations `0001` through the latest numbered migration to the intended database, then run CI. Confirm API `/health`, API `/api/meta/readiness`, authenticated media upload and processing, a LiveKit sandbox session, and PayPal sandbox checkout/capture/refund/webhook delivery.

The API now respects Render's provided `PORT` environment variable (falling back to `API_PORT` locally). The static site receives only public runtime configuration; service-role, PayPal secret and LiveKit API secret variables are not emitted into the static bundle.
