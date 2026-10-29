# ZUNO repository map

- `apps/web/src/app/`: client boot and route coordination.
- `apps/web/src/features/<domain>/`: feature-specific client code.
- `backend/<service>/src/`: service-owned behavior and contracts.
- `database/migrations/NNNN_*.sql`: canonical, ordered schema and RLS changes.
- `packages/`: shared contracts and domain-independent primitives.
- `assets/manifests/`: resolved paths and provenance for bundled assets.

Add subfolders by capability and code ownership. Avoid duplicate business logic in clients. Persisted features need migrations, authorization rules, tests and operational documentation. No placeholder-only directories.
