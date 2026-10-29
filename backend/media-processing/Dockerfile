FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# ffmpeg and ffprobe are explicit runtime dependencies of the media worker.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY . .
RUN pnpm install --frozen-lockfile

USER node
CMD ["pnpm", "--filter", "@zuno/backend-media-processing", "worker"]
