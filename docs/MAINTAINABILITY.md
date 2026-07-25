# Maintainability

This document defines the conventions used to keep RefHaven readable,
auditable, and safe to change.

## Design rules

- Prefer cohesive modules over generic utility collections. A file should have
  one clear reason to change.
- Keep domain logic free of VS Code APIs. Application controllers orchestrate;
  infrastructure talks to Git or persistence; UI adapters render and collect
  input.
- Order code by reader flow: public API and lifecycle first, related private
  helpers next, low-level validation last. Alphabetical ordering is used only
  when it improves lookup, such as command registries or declarative maps.
- Extract a constant when a value expresses a policy, limit, protocol field,
  timeout, cache bound, or shared presentation rule. Simple local arithmetic
  does not need a named constant.
- Reuse validation at trust boundaries. Do not duplicate regular expressions
  for Git object IDs, paths, refs, origins, or stored schemas.
- Keep runtime dependencies at zero. Prefer Node and VS Code APIs; every new
  development dependency requires a documented supply-chain justification.

## TypeScript

The compiler configuration is the baseline contract: strict mode,
`exactOptionalPropertyTypes`, unchecked-index protection, unused-code checks,
and override enforcement stay enabled.

- Use discriminated unions for state and command contexts.
- Accept `unknown` at external boundaries and narrow before use.
- Prefer immutable `readonly` data and explicit return types on exported APIs.
- Avoid assertions unless validation has already established the invariant.
- Preserve domain-specific error types only when callers make a concrete
  decision from them.

## Comments and API documentation

RefHaven uses TSDoc-compatible comments (`/** ... */`). Document exported APIs,
security boundaries, non-obvious invariants, and the reason behind surprising
code. Do not restate names or narrate straightforward control flow.

Git range semantics, persistence formats, security guarantees, and other
cross-module contracts belong in `docs/` or `SECURITY.md`, with source comments
linking to them where useful.

## Configuration and limits

- VS Code settings are owned by `src/config/extensionConfiguration.ts`.
- Shared interactive limits live in `src/domain/inputLimits.ts`.
- Git process bounds and scheduling live in
  `src/infrastructure/git/GitProcess.ts`.
- Manifest defaults and runtime defaults must match.

Avoid hidden fallback values in controllers. A new setting requires a manifest
entry, runtime constant, tests, README documentation, and a security review.

## Errors and logging

User-facing errors may explain the failed local operation. Operational logs
must contain only stable event text, a bounded `operation`, counts/durations,
and a sanitized error identifier. Never log exception messages, repository
roots, file paths, refs, SHAs, authors, emails, subjects, remote URLs, content,
environment values, or credentials.

Fire-and-forget work uses `runInBackground`. Command boundaries use
`errorLogMetadata` and may separately display a safe domain error to the user.

## Review gates

Every change must pass:

```text
npm run format:check
npm run lint
npm run compile
npm run quality
npm run test:unit
npm run test:extension
npm audit --audit-level=low
npm audit signatures
npm run package
npx vsce ls --no-dependencies
```

Reviewers also verify that repository data remains within the documented local
and explicitly approved GitLab trust boundary.
