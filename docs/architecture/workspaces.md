# Workspace ownership

pnpm workspaces include web/desktop/admin/TV/Creator Studio clients, backend services, provider adapters and shared packages. Native Android and iOS projects have their own platform-native build systems and are intentionally excluded from JavaScript workspaces.

Each workspace manifest exposes only commands that operate on actual source files. Repository-wide tests are coordinated through the root runner, which discovers tests by suite. A manifest does not claim a backend service or provider is production-connected.

Run `pnpm platforms:validate` to confirm required platform files exist, no repository placeholder files remain, and each JavaScript workspace has a package manifest.
