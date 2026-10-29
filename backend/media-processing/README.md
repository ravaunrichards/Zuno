# ZUNO media worker container

This image runs the durable Supabase-backed media-processing worker. It installs
both `ffmpeg` and `ffprobe` at image-build time; a generic Render Node runtime
does not guarantee those executables exist. The service needs the following
Render environment variables, configured as secrets in the Render dashboard:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_MEDIA_BUCKET` (defaults to `zuno-media`)
- `MEDIA_SIGNED_URL_TTL_SECONDS` (defaults to `600`)

The Docker build uses the root pnpm lockfile for a reproducible workspace install.
Do not include provider credentials in image build arguments or this repository.
