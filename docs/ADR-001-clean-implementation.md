# ADR-001: Use a clean implementation

- Status: Accepted
- Date: 2026-07-14
- Decision owners: RefHaven maintainers

## Context

RefHaven targets the focused Search & Compare / Compare References capability historically available in GitLess/GitLens, but it has a deliberately narrower product boundary and a persistence-first model. The proposed architecture requires strict separation between Git processes, typed Git operations, comparison semantics, workspace persistence, controller state, a native Tree View, and immutable revision documents.

The technical-spike question was whether to extract historical `SearchAndCompareView`, `CompareResultsNode`, Git service, and revision-provider code from GitLens/GitLess 11.7 or build these focused components directly.

The source workspace begins as a new standalone extension with no inherited GitLens container, service graph, view framework, node hierarchy, configuration system, licensing files, or compatibility constraints. Faithfully extracting old view nodes would therefore require first importing or replacing a meaningful portion of their surrounding infrastructure. That coupling would work against the extension's small scope and its normative domain vocabulary.

## Decision

Implement RefHaven cleanly against public VS Code extension APIs and the Git CLI. Do not extract the historical GitLens/GitLess view, container, Git service, revision provider, branding, icons, or assets.

GitLens/GitLess may be used as behavioural research and prior art during development, subject to its applicable historical licence. Any future reuse of MIT-licensed implementation code must be isolated, justified, reviewed, and accompanied by the required copyright and licence notice.

### Behavioural baseline reviewed on 2026-08-15

The feature-maturity audit used only GitLens's official public documentation:

- <https://help.gitkraken.com/gitlens/gitlens-features/>
- <https://help.gitkraken.com/gitlens/gitlens-settings/>
- <https://help.gitkraken.com/gitlens/gl-visual-file-history/>
- <https://help.gitkraken.com/gitlens/gitlens-release-notes-current/>

These sources establish a dated behavioural baseline for blame, heatmap,
search, and visual history. No source code, assets, strings, or internal design
were copied. Re-check the official documentation during the next audit because
competitor behaviour changes independently of RefHaven.

## Rationale

- The feature depends on concepts that are small and directly expressible with `TreeView`, `TreeDataProvider`, commands, `TextDocumentContentProvider`, `vscode.diff`, and argument-safe Git subprocesses.
- Extracting historical view nodes without their service container would create an adapter layer comparable in size to a focused implementation.
- The new automatic workspace persistence model differs materially from historical keep/pin behaviour.
- Normative `baseRef`/`targetRef` semantics, two explicit diff modes, typed errors, generation-based refresh, and bounded scheduling are easier to verify in an independent domain.
- A clean implementation reduces inherited scope, transitive dependencies, branding/licensing risk, and maintenance burden.
- Test-first Git parsers and temporary-repository fixtures can establish correctness without depending on another extension's internals.

## Consequences

Positive consequences:

- small and auditable dependency surface;
- architecture tailored to persistent multi-comparison workflows;
- direct control of Git ranges, NUL parsing, cancellation, output limits, and caching;
- no runtime or packaging dependency on GitLens/GitLess;
- clearer ownership of accessibility and native VS Code behaviour.

Costs and risks:

- native Tree View behaviour, repository discovery, revision URIs, and unusual Git cases must be implemented and tested locally;
- historical edge cases are not inherited automatically;
- behavioural parity requires explicit scenario testing rather than code reuse;
- the technical spike's Extension Development Host inspection is replaced by source/dependency analysis because importing and running the legacy product would not change the dependency conclusion for this empty standalone workspace.

## Guardrails

- Keep GitProcess independent from comparisons and VS Code UI.
- Keep Tree View nodes free of Git execution.
- Persist symbolic configuration only; results and SHAs remain runtime data.
- Use public VS Code APIs and shell-free Git argument arrays.
- Do not copy product branding, icons, screenshots, or assets.
- Record any later proposal to change protected semantics or reuse external code in a new ADR before implementation.

## Alternatives considered

### Extract the historical feature

Rejected because the view and node classes rely on broader service, configuration, Git, and presentation infrastructure. Recreating that environment would import significant unrelated scope and still require adaptation for the new persistence and runtime model.

### Depend on GitLens as an installed extension

Rejected because RefHaven must remain standalone, predictable, packageable, and testable without another optional extension or its non-public APIs.

### Use a Webview implementation

Rejected because the product benefits from native tree accessibility, keyboard behaviour, menus, theming, file icons, performance, and `vscode.diff` integration, while a Webview would add an unnecessary host/UI protocol.

## Validation

The decision is validated incrementally by the milestone acceptance gates: a small strict extension skeleton, independently tested Git semantics and parsers, persistence tests, native Tree View Extension Host tests, immutable revision-provider tests, and the cross-platform matrix in [TEST-MATRIX.md](TEST-MATRIX.md). If implementation demonstrates that a clean component requires i dddd mporting a significant external framework, work stops and this decision is revisited through a superseding ADR.
