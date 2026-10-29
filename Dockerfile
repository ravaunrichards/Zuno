# Multi-stage build for the ZUNO API service.
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY backend ./backend
RUN pnpm install --frozen-lockfile || pnpm install

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app ./
# Do NOT copy .env or any credential files into the image.
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node backend/api/healthcheck.js || exit 1
CMD ["node", "backend/api/src/server.js"]
