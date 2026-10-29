# ZUNO repository map

This is the ownership map for the canonical root folders. Add nested directories by domain and layer instead of placing unrelated files at the same level.

## Platform apps

- `apps/web/src/app/`: client startup and route coordination.
- `apps/web/src/components/`: navigation and shared page components.
- `apps/web/src/features/<domain>/`: domain-specific client behavior.
- `apps/web/src/services/`: HTTP clients and provider-neutral contracts.
- `apps/web/src/styles/`: design tokens, layout, components and responsive rules.
- `apps/android/app/src/main/`: native Android application, Compose screens, resources and manifest.
- `apps/ios/ZunoApp/`: SwiftUI app and navigation.
- `apps/desktop/`: isolated desktop shell wrapping the web client.
- `apps/tv/`: remote-first browsing interface.
- `apps/admin/`: secure operations workspace.
- `apps/creator-studio/`: creator publishing and analytics workspace.

## Backend

Each service owns its own domain behavior under `src/`, with explicit inputs and outputs. `backend/api/src/server.js` remains the HTTP entry point until route modules are migrated in a reviewed change. Provider credentials, payment state transitions and authorization stay server-side.

## Data and migrations

`database/migrations/NNNN_*.sql` is the canonical ordered migration chain. Policies and database functions are migrated in that chain; the adjacent `database/policies/` and `database/functions/` folders contain documentation and reviewed reusable source references, not a second migration queue. Do not edit an applied migration in place; add a new migration.

## Shared packages

- `packages/api-contracts/`: stable request/response schemas.
- `packages/auth/`: authentication and session primitives.
- `packages/database/`: database access conventions.
- `packages/design-system/` and `packages/ui/`: shared tokens and components.
- `packages/gift-engine/`: catalog, progression, rendering and delivery rules.
- `packages/payments/`: package definitions, state machine and revenue split rules.
- `packages/validation/`: reusable input checks.
- `packages/media/`: media validation and transformations.
- `packages/shared/`: money-safe ledger and common utilities.

## Rules of ownership

1. One implementation per domain concern; clients consume shared contracts rather than copying business rules.
2. Each persisted feature adds its schema, migration, row-level security policies, tests and operational notes.
3. Each integration lists environment variables, verification method, unavailable behavior and recovery path.
4. Asset references must be resolvable and included in the appropriate manifest.
5. No folder is created just to reserve a name; every committed folder contains an actual implementation, schema, test, asset or useful operational document.
