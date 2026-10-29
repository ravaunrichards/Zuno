# Contributing to ZUNO

1. Preserve the canonical top-level repository structure. Place code under the owning app, backend service, shared package or integration.
2. Implement complete source files; avoid placeholder-only directories, duplicate business logic and invented service responses.
3. Persistent data changes require a new numbered migration, explicit RLS policy review, constraints/indexes where appropriate and tests. Never edit a migration after it has been applied to a shared environment.
4. Client identity and role must be derived from provider-verified sessions. Sensitive actions require server-side authorization.
5. Financial changes must be atomic, idempotent, balanced in the ledger, reconciled against the provider and tested for duplicate/replayed events.
6. Media uploads must validate actual file bytes and process files in an isolated worker before publication.
7. Include unit/integration/accessibility/security coverage appropriate to the change, and run the relevant verification scripts.
8. Update documentation and the implementation register when capabilities or limitations change.
9. Never commit secrets, private user data, fake payment results or fabricated test reports.
10. Do not deploy or change production services without explicit authorization.
