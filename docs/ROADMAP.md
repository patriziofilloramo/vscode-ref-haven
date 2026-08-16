# Roadmap

RefHaven is a local Git investigation workspace for VS Code: fast, native-UI,
no webviews, no telemetry. Features are chosen for high daily value at low to
medium implementation and maintenance cost.

This document is forward-looking. For what has already shipped, see
[CHANGELOG.md](../CHANGELOG.md).

## Security boundary

The objective is not absolute offline operation. Repository data may be
processed:

1. on your workstation; and
2. by the Git host your repository is already configured to use, and only when
   you explicitly ask for it.

Repository data must never reach RefHaven-operated infrastructure, telemetry
or analytics services, AI providers, public metadata services, third-party
relays, or any host you have not chosen.

This boundary shapes what may be built:

- explicit, user-initiated local Git mutations are allowed once their effects,
  failure modes, and repository-configured helper behaviour are reviewed and
  tested;
- browser handoffs to the repository's own Git host are in scope;
- background network activity, automatic third-party discovery, and implicit
  transmission of repository metadata are out of scope;
- no feature may require a RefHaven backend or intermediary service;
- remote-aware features must fail closed when the host is not the one the user
  configured.

The shipped implementation contains one deliberately bounded local repository
mutation, **Stash This File...**. It uses a written fail-closed transaction and
manual-recovery contract: standard stash publication precedes cleanup,
concurrent state is never force-overwritten, and evacuated file bytes remain
in a repository-local Git metadata safety directory until the user verifies and removes
them. An incomplete journal may also retain a private recovery ref, which must
be deleted with its expected stash SHA during manual cleanup. Every other repository view remains read-only. Remote handoff is limited
to explicit browser links to a validated origin.
`SECURITY.md`, `PRIVACY.md`, `PRODUCT.md`, and `ARCHITECTURE.md` are updated
with every boundary change, so the documented guarantees match the code. The
no-egress property is enforced by a guard test rather than by convention.

## Next

New work comes from the gaps and promotion gates in
[`FEATURE-MATURITY.md`](FEATURE-MATURITY.md), not from adding another permanent
Source Control section. The current priorities are annotation visual evidence,
Remote SSH verification, and release-grade screenshots; prefer refining the
four existing views.

Any future mutation—including cherry-pick from Ahead/Behind commits—must meet
the same gate as the single-file stash: real-repository integration tests, a
written failure and recovery contract, deterministic concurrency coverage, and
no reliance on repository-configured hooks or executable helpers.

## Deliberately deferred

- **Commit graph webview** — high layout, rendering, accessibility, and
  maintenance cost; revisit only on strong demand.
- **Custom webview UI** — native VS Code UI stays the default unless a workflow
  genuinely cannot be expressed accessibly with native APIs.
- **Git CodeLens** — per-symbol blame is performance-sensitive; revisit after
  the rich line hover has been measured on large repositories.
- **Git host API integration** (merge-request or pipeline status) — the
  URL-only handoff avoids tokens, stored credentials, and response handling.
  Add it only if the URL-only approach proves insufficient for a concrete use
  case.
- **Automatic fetch or push** — must never be introduced as implicit background
  activity.
- **AI review or enrichment** — incompatible with the data boundary above.
- N-way comparisons, cross-repository comparison, recursive submodule
  management, and replacing VS Code's built-in Git client.

## Working agreements

- Keep the layered architecture: typed Git plumbing with tested parsers in
  `infrastructure/git`, orchestration in `application`, native tree and editor
  presentation in `ui`, and VS Code-free types in `domain`.
- Prefer platform APIs and the Git executable already installed; production
  dependencies remain prohibited.
- Every mutation command needs real-repository integration tests and a written
  failure and recovery contract.
- Every remote-aware feature needs an explicit data-flow review, host
  validation, redaction tests, and a no-network degradation test.
- Every change must compile, lint, pass the unit and Extension Host suites,
  clear the quality and egress gates, and package successfully.
- Update `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `TEST-MATRIX.md`, and
  `CHANGELOG.md` whenever behaviour or the security boundary changes.
