# Platform implementation matrix

The UI and app configuration in a repository do not by themselves prove a production-ready build. Use this matrix to keep platform status explicit.

| Client | Source location | Current delivery goal | Verification required |
| --- | --- | --- | --- |
| Web / PWA | `apps/web/` | Responsive social workspace with feed, discovery, LIVE entry, gifts and creator tools | Static asset check, API integration checks, accessibility and browser E2E |
| Android | `apps/android/` | Native Android app with app navigation, camera/mic permission gates and secure API session | Gradle compile, unit tests, emulator/device smoke tests and signed release build |
| iOS | `apps/ios/` | Native SwiftUI app with platform navigation and safe session handling | Xcode build, unit/UI tests, device smoke tests and signing configuration |
| Desktop | `apps/desktop/` | Hardened desktop shell around the shared web experience | Dependency audit, package build and navigation/security smoke tests |
| TV | `apps/tv/` | Large-screen remote-first discovery interface | Keyboard/remote navigation, focus order and TV device testing |
| Admin | `apps/admin/` | Authenticated operations and moderation workspace | Role enforcement, audit-log tests and admin E2E |
| Creator Studio | `apps/creator-studio/` | Content preparation and creator operations | Upload/API contract tests, media validation, accessibility and browser E2E |

## Shared requirements

All clients must respect authorization returned by the backend, use HTTPS outside local development, avoid embedding service-role keys, support loading/error/empty states, and clearly communicate when a server capability is not configured. Sensitive operations are never authorized merely because a button is visible.

## Native toolchain limits

Android verification requires a JDK, Android SDK and Gradle. iOS requires macOS/Xcode and signing setup. These builds must be marked **not run** if the relevant toolchain is unavailable; JavaScript lint is not a substitute for native build verification.
