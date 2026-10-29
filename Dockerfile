# Multi-stage build for the ZUNO API service.
# .dockerignore excludes secrets, local build output and developer dependencies.
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

FROM base AS deps
COPY . .
RUN pnpm install --no-frozen-lockfile

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app /app
WORKDIR /app
# API binds to Render's PORT when present; API_PORT remains the local fallback.
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node backend/api/healthcheck.js || exit 1
CMD ["pnpm", "--filter", "@zuno/backend-api", "start"]
