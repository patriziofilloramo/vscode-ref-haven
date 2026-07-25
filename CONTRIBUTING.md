# Contributing to RefHaven

RefHaven is maintained for security-sensitive environments. A change is ready
for review only when its behavior, trust boundary, failure modes, tests, and
documentation agree.

## Workflow

1. Create a focused branch from current `master`.
2. Keep commits reviewable and avoid unrelated formatting churn.
3. Add or update unit tests for pure logic and Extension Host tests for VS Code
   integration behavior.
4. Update user documentation and security documentation in the same change
   when the product contract changes.
5. Run every gate in `docs/MAINTAINABILITY.md`.

## Review checklist

- Repository-controlled inputs are validated before filesystem, process,
  Markdown, URI, clipboard, or browser use.
- Git runs through the local-only process boundary with literal argument arrays.
- No repository data is logged or sent to a new process, host, telemetry
  service, API, or provider.
- Cancellation, stale-result protection, resource limits, and disposal remain
  correct.
- Names describe domain intent; comments explain invariants rather than syntax.
- Settings and limits are centralized instead of repeated in controllers.
- No production dependency is added, and development pins remain exact,
  justified, audited, and lockfile-integrity pinned.
- Public/runtime surfaces contain only RefHaven branding and the `refhaven.`
  command namespace; external-product research remains in explicit internal
  provenance records.

Architecture rules are documented in `docs/ARCHITECTURE.md`; coding and
documentation conventions are in `docs/MAINTAINABILITY.md`.
Public-release ownership, licensing, name-clearance, and packaging gates are
documented in `docs/PUBLISHING.md`.
