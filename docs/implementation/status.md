# Implementation status ledger

This file separates existing code from verified behavior. Update it only when the corresponding check or integration has actually been run.

| Area | Repository evidence | Status rule |
| --- | --- | --- |
| Web homepage | Responsive web app source and client-side interactions | UI implemented; API-backed data depends on the available endpoints |
| Gift catalog | Bundled catalog, manifest and geometry/audio files | Validate every reference; do not equate similarly sized audio files with distinct sounds |
| API | Dependency-free Node HTTP server and provider adapters | Local endpoints require tests; provider operations require real sandbox verification |
| Supabase | REST/Auth adapter and ordered SQL | Not connected until endpoint/credentials are provided and actual queries execute |
| LiveKit | Token adapter and guest-request state machine | Not a production live-room system until auth, room permissions and webhooks are wired and tested |
| PayPal | Checkout integration module | Not production-ready until capture, signed webhooks, idempotency, reconciliation, refunds and payout eligibility pass |
| Android / iOS | Native client projects | Build state is unknown until the actual native toolchains run |
| Desktop / TV / Admin / Creator Studio | Client implementations | Client UI is not proof of authenticated production integration |
| CI | GitHub Actions workflow | Run status must come from a real workflow run |
| Deployments | Render configuration and docs | No deployment is implied by repository configuration |

## Status vocabulary

- **Verified:** a repeatable check succeeded in the named environment and the evidence is recorded.
- **Implemented, not verified:** source exists but the relevant test/provider/toolchain has not been run.
- **Blocked:** missing credential, service access, hardware, native toolchain or user approval prevents verification.
- **Not implemented:** a real implementation is still missing.

Never change an item to Verified on the basis of a static code review alone.
