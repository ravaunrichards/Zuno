# ZUNO media processing worker

The worker claims durable `media` queue jobs from PostgreSQL using the service-role-only job functions. It re-reads the server-owned media record, checks that the storage path is under the owning profile's private prefix, downloads the object with a size cap, validates the actual file signature and expected stream type, probes it with `ffprobe`, transcodes it with `ffmpeg`, uploads a derivative, and only then marks the asset `ready`.

Supported derivative outputs are WebP images, H.264/AAC MP4 video, and AAC/M4A audio. Unrecognized or mismatched files are quarantined. Transcode/provider failures are retried through the durable queue and eventually marked failed after the configured attempt limit.

Required runtime: Node.js 20+, `ffmpeg` with WebP/H.264/AAC support, `ffprobe`, and server-only Supabase credentials. The worker does not trust browser MIME metadata or a caller-provided storage path. Never expose `SUPABASE_SERVICE_ROLE_KEY` or worker credentials to clients.
