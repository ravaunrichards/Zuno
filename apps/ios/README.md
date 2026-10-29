# iOS app

The iOS shell embeds the same production ZUNO web bundle used by the web and Android clients. During the XcodeGen build workflow, `pnpm build:web` is run first and the complete output—including CSS, bundled client JavaScript, PWA files and the procedural gift models—is copied into `Resources/ZunoWeb`.

At launch, the app serves only that directory through an ephemeral HTTP listener bound to loopback (`127.0.0.1`), then opens it in `WKWebView`. Request paths are normalized and traversal outside the resource directory is rejected. This permits the bundled ES-module client and browser camera/microphone APIs to run without loading an unbundled `file://` page or exposing a JavaScript-to-native bridge.

Camera and microphone permission requests are presented by WebKit only for the app's loopback origin. ZUNO API endpoints and the public Supabase URL/anonymous key can be supplied to the web build using `ZUNO_PUBLIC_API_BASE_URL`, `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Never put a Supabase service-role key, PayPal secret, LiveKit API secret or other server credential into the mobile bundle.

Build locally from the repository root:

```sh
pnpm install --no-frozen-lockfile
pnpm build:web
mkdir -p apps/ios/Resources/ZunoWeb
cp -R dist/web/. apps/ios/Resources/ZunoWeb/
cd apps/ios
xcodegen generate --spec project.yml
xcodebuild -project ZUNO.xcodeproj -scheme ZUNO -sdk iphonesimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO
```

Simulator compilation is covered by `.github/workflows/ios-build.yml`. Signing, device camera/microphone hardware behaviour, and App Store submission are not claimed until tested with an Apple signing identity and physical device.
