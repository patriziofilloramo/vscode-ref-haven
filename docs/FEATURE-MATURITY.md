# Feature maturity

This is the product-control document for RefHaven. It answers four questions
for every capability: why it exists, how mature it is, where it trails the
relevant leading-product baseline, and what evidence is still required.

The product stays centered on three promises:

1. **Review locally** — compare, forecast, inspect, and review changes without a
   service.
2. **Understand code** — explain a line or scan a file using local Git data.
3. **Act safely** — make narrowly scoped local changes or open an explicitly
   validated browser destination.

## Maturity levels

- **Stable:** automated coverage, documented limits, and repeated manual release
  evidence exist. It may be presented as a primary feature.
- **Beta:** useful and intentionally supported, but one or more manual,
  cross-platform, usability, or benchmark gates remain. It may be discoverable
  contextually, but should not dominate the product promise.
- **Supporting:** valuable inside another workflow, not a standalone product
  promise. Keep it contextual rather than adding Command Palette entries.
- **Deferred:** deliberately not built. A privacy or simplicity rationale must
  be recorded; otherwise it remains a real competitive gap.
- **Sunset:** no longer justifies its complexity. De-expose first, remove only in
  a documented breaking release after migration impact is understood.

## Capability matrix

| Capability                                        | Promise         | Level      | Leading-baseline delta                                                                                                                                                                              | Evidence and decision                                                                                                                                                                                                        |
| ------------------------------------------------- | --------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent directional branch comparisons         | Review locally  | Stable     | Different focus, not a deficit                                                                                                                                                                      | Unit and Extension Host coverage for persistence, repository boundaries, modes, diffs, and stale state. Keep and lead with it.                                                                                               |
| Native review flow and bounded patch export       | Review locally  | Stable     | RefHaven is deliberately narrower than hosted review integrations                                                                                                                                   | Review state, navigation, byte-preserving export, and limits are automated. Keep.                                                                                                                                            |
| Local merge forecast                              | Review locally  | Stable     | No material deficit for its stated scope                                                                                                                                                            | Clean/conflict and external-driver fail-closed paths are tested without worktree mutation. Keep.                                                                                                                             |
| Rich current-line hover                           | Understand code | Stable     | Strong local alternative; no cloud enrichment by design                                                                                                                                             | Default-on, lazy, escaped, cancellable, revision-aware, limited to four primary actions, and backed by a validated contextual action menu. Keep.                                                                             |
| Current-line inline/status blame                  | Understand code | Stable     | Less visual customization than the leading baseline                                                                                                                                                 | Reliable, mode-controlled, compact, single-line, and bounded. Add formatting settings only for a demonstrated usability need.                                                                                                |
| Whole-file blame                                  | Understand code | Beta       | Now provides author, age, summary, commit grouping, hover, theme color, and compact/detailed formats; visual validation still trails the leading baseline                                           | Automated presentation and manifest coverage exist. Promote to Stable after the annotation manual matrix passes on every release platform and Remote SSH.                                                                    |
| File heatmap                                      | Understand code | Beta       | Fixed bands favor predictable meaning over the leading baseline's relative median-age brightness; navigation, file/window scope, Escape, dirty buffers, and accessible legend are covered by design | Keep the fixed-band distinction. Promote after theme, large-file, Remote SSH, and screenshot gates pass.                                                                                                                     |
| Changes-relative-to-ref annotations               | Review locally  | Beta       | No important privacy-related deficit                                                                                                                                                                | Supports dirty buffers and restores a validated workspace baseline. Keep contextual; promote after visual, reload, and Remote SSH evidence.                                                                                  |
| File and line history, readonly revisions         | Understand code | Beta       | Strong native baseline with paging, pinning, file/line switching, and visible rename tracking; still lacks base-ref/all-branches controls and a visual timeline                                     | Cursor paging across renames, `git log -L`, cancellation, native diffs, and revision URI security are automated. Keep and improve. Promote after large-history, theme, multi-root, and Remote SSH manual gates are recorded. |
| Local commit search and details                   | Understand code | Stable     | Explicit local-only semantics rather than hosted search                                                                                                                                             | Literal/regex, case controls, query bounds, escaping, no-textconv content search, and real-Git behavior are tested. Keep.                                                                                                    |
| Single-file stash                                 | Act safely      | Stable     | A differentiated, intentionally narrow mutation                                                                                                                                                     | Extensive fail-safe, concurrency, byte, linked-worktree, and security regression coverage. Keep; detailed mechanics stay outside the README.                                                                                 |
| Existing stash inspection                         | Review locally  | Stable     | Narrower than a full Git client by design                                                                                                                                                           | Native diffs, stats, filters, revision/history actions, and bounded search are covered. Keep.                                                                                                                                |
| Browser links and reference autolinks             | Act safely      | Stable     | No automatic host API, token, or PR enrichment by design                                                                                                                                            | Exact-origin validation, immutable refs, host grammars, escaping, and no-egress guards are tested. Keep.                                                                                                                     |
| Branch/worktree navigation                        | Review locally  | Supporting | Read-only and less visual than the leading baseline                                                                                                                                                 | Valuable context for comparisons; keep in the Source Control view, not as a headline.                                                                                                                                        |
| Compatibility aliases and refresh/layout commands | Supporting      | Supporting | Not a feature gap                                                                                                                                                                                   | Keep contextual or hidden from the Command Palette. Review for removal only at a breaking-version boundary.                                                                                                                  |
| Visual file history/commit graph webviews         | Understand code | Deferred   | The leading baseline is materially richer                                                                                                                                                           | Deliberate simplicity/privacy tradeoff: native views avoid a large custom UI and its maintenance surface. Reconsider only with a concrete user workflow that native editors cannot serve.                                    |
| Cloud PR/issue dashboards, accounts, and AI       | None            | Deferred   | The leading baseline is materially richer                                                                                                                                                           | Deliberate product boundary: no backend, token, telemetry, or background network activity. Not a defect.                                                                                                                     |

The baseline is refreshed during a feature audit from the competitor's official
feature overview, settings reference, visual-history documentation, and current
release notes. Dated source links live in the
[clean-implementation decision record](ADR-001-clean-implementation.md#behavioural-baseline-reviewed-on-2026-08-15)
rather than in customer-facing product copy; competitor behavior is not a stable
specification.

## Release gates

A Beta capability becomes Stable only when all applicable gates are recorded in
the release report:

- unit tests for parsing, normalization, boundaries, and presentation;
- Extension Host tests for command wiring and persisted/session state;
- manual light, dark, and high-contrast verification;
- clean, dirty, empty, non-ASCII, and bounded-large-file scenarios;
- multi-root, nested-folder, and Remote SSH verification;
- cancellation and repeated-toggle behavior;
- a benchmark with hardware, dataset, line count, and timing;
- a real product screenshot after the UI is stable.

CI is necessary evidence, not a substitute for visual or remote verification.
If a release cannot supply a gate, the feature remains Beta and release notes
must say so plainly.

## Simplicity policy

- The Command Palette exposes primary jobs, not every registered command.
  Contextual tree, editor, Explorer, and Source Control commands remain where
  their target is unambiguous.
- New settings require a meaningful user choice. A setting is not a substitute
  for a coherent default.
- The README presents the three promises. Detailed safety protocols and feature
  inventories live in focused documents.
- A new feature needs an owner, a maturity row, a test route, a manual scenario,
  documented limits, and either a competitive baseline or a reason none applies.
- In a project with no telemetry, lack of evidence is not evidence of no use.
  Sunset decisions use issue feedback, release testing, maintenance cost, and
  overlap with stronger workflows.

## Current next actions

1. Complete and record the whole-file annotation manual matrix, including
   Remote SSH and an actual screenshot.
2. Record changes-annotation reload and dirty-buffer behavior in the same
   local/Remote SSH visual matrix.
3. Reassess inline/status formatting only after annotation Beta gates are closed.
4. Record three-page file/line-history behavior, cancellation, pinning, and
   rename tracking on a large repository in local and Remote SSH sessions.
5. Reassess base-reference and all-branches history controls after that gate;
   they are functional competitive gaps, not privacy constraints.
6. Audit the matrix before every minor release and before advertising any new
   headline feature.
