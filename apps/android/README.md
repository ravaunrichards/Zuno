# Android client

Native Android source is in `app/src/main/java/com/zuno/app/MainActivity.kt`. The Gradle project uses Jetpack Compose and declares network, camera, microphone and notification capabilities.

Runtime permission prompts must be implemented before capture or streaming; the declarations alone are not permission grants. Authenticated API sessions, feed persistence, media upload, LiveKit and wallet operations require integration and tests. This project has not yet been verified by an Android SDK build.
