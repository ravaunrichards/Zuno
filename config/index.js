'use strict';
/**
 * Centralized typed configuration + environment validation.
 * Reads process.env, reports which providers are configured, and exposes
 * feature flags. Missing provider credentials do NOT crash the process — the
 * corresponding integration returns an explicit 503 (REQUIRES_CONFIGURATION)
 * instead of pretending to work.
 */
function bool(v, def = false) {
  if (v === undefined) return def;
  return String(v).toLowerCase() === 'true';
}

function load(env = process.env) {
  const supabase = {
    url: env.SUPABASE_URL || '',
    anonKey: env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    jwtSecret: env.SUPABASE_JWT_SECRET || '',
  };
  const livekit = {
    url: env.LIVEKIT_URL || '',
    apiKey: env.LIVEKIT_API_KEY || '',
    apiSecret: env.LIVEKIT_API_SECRET || '',
    webhookKey: env.LIVEKIT_WEBHOOK_KEY || '',
  };
  const paypal = {
    env: env.PAYPAL_ENV || 'sandbox',
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    payoutsEnabled: bool(env.PAYPAL_PAYOUTS_ENABLED),
  };
  const config = {
    nodeEnv: env.NODE_ENV || 'development',
    appBaseUrl: env.APP_BASE_URL || 'http://localhost:3000',
    apiPublicBaseUrl: env.ZUNO_PUBLIC_API_BASE_URL || '',
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean),
    storageBucket: env.SUPABASE_MEDIA_BUCKET || 'zuno-media',
    mediaSignedUrlTtlSeconds: Number(env.MEDIA_SIGNED_URL_TTL_SECONDS || 600),
    apiPort: Number(env.API_PORT || 4000),
    rankingResetTz: env.RANKING_RESET_TZ || 'America/Jamaica',
    supabase,
    livekit,
    paypal,
    features: {
      productionPayments: bool(env.FEATURE_PRODUCTION_PAYMENTS),
      payouts: bool(env.FEATURE_PAYOUTS),
      liveRecording: bool(env.FEATURE_LIVE_RECORDING),
    },
  };
  config.configured = {
    supabase: Boolean(supabase.url && supabase.anonKey && supabase.serviceRoleKey),
    livekit: Boolean(livekit.url && livekit.apiKey && livekit.apiSecret),
    paypal: Boolean(paypal.clientId && paypal.clientSecret),
  };
  return config;
}

/** Throw only for genuinely required base config; providers are optional/gated. */
function validateRequired(config) {
  const problems = [];
  if (!config.appBaseUrl) problems.push('APP_BASE_URL is required');
  if (!Number.isFinite(config.apiPort)) problems.push('API_PORT must be a number');
  if (config.features.productionPayments && !config.configured.paypal) {
    problems.push('FEATURE_PRODUCTION_PAYMENTS=true but PayPal credentials are missing');
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { load, validateRequired };
