# Roadmap

RefHaven is growing toward a GitLens-style feature set while staying a fast,
native-UI, no-webview, no-telemetry extension. Features are selected for high
daily value at low-to-medium implementation and maintenance cost.

Each batch must compile, lint, pass unit and Extension Host tests, package
successfully, and receive a security review before it merges to `master`.

## Security boundary

The security objective is not absolute offline operation. Repository data may
be processed:

1. on the developer workstation; and
2. directly by repository services explicitly authorised by the organisation,
   such as the configured on-premise GitLab instance.

Repository data must never be sent to RefHaven-operated infrastructure,
telemetry or analytics services, AI providers, public metadata services,
third-party relays, or repository hosts that have not been explicitly trusted.

This clarification changes the planned product boundary:

- explicit, user-initiated local Git mutations may be implemented when their
  effects, failure modes, and repository-configured helper behaviour have been
  reviewed and tested;
- direct integration with an approved GitLab host is in scope;
- background network activity, automatic third-party discovery, and implicit
  transmission of repository metadata remain out of scope;
- no feature may require a RefHaven backend or intermediary service;
- remote-aware features must fail closed when the remote host is not approved.

The current implementation includes one hardened local mutation and explicit
approved-GitLab browser links. `SECURITY.md`, `PRODUCT.md`, and
`ARCHITECTURE.md` are updated with each boundary change so the documented
guarantees match the shipped code.

## Delivered

### Rich comparison UI (merged 2026-07-15)

- Persistent, directional branch comparisons with pin, swap, refresh, and
  close.
- Ahead/Behind commit sections with paging; commits expand to the files they
  changed (first-parent diff; root commits diff against the empty tree).
- Changed files as a flat list or compacted folder tree with SCM-style status
  decorations, diff stats, and rich tooltips.
- Native readonly diffs through a shared `FileDiffScope`, reused by
  comparisons, single commits, and stashes.
- Read-only Stashes view: list per repository, expand to files, native diffs,
  refresh, and copy actions.
- File context actions: Open File, Copy Path, Copy Relative Path; commit
  context actions: Copy SHA, Copy Commit Message.

### Batch 1 — Editor intelligence (completed 2026-07-15)

- Current-line inline blame with dimmed end-of-line text (works in dirty
  buffers via `git blame --contents -`).
- Blame hover with Copy SHA, Copy Message, and Open File at This Revision
  command links; status-bar blame with a quick pick of the same actions.
- `refhaven.inlineBlame.enabled` and `refhaven.statusBarBlame.enabled`
  settings plus a Toggle Inline Blame command.
- Open File at Revision command (interactive reference picker or direct
  invocation from blame links).
- Auto-refresh: a `.git` metadata watcher refreshes comparisons, stashes, and
  blame after commits, branch switches, fetches, and stash operations.

### Security and reliability hardening (2026-07-15)

- Centrally restricted local Git execution with a process scheduler, timeouts,
  output limits, and cancellation via `AbortSignal`.
- Signed revision URIs, path identity normalisation, worktree-aware `.git`
  metadata watching, bounded caches, and Markdown escaping of Git-controlled
  text.
- Production dependencies prohibited and development dependencies exact- and
  integrity-pinned.

### Comparison mode switching and empty-state clarity (2026-07-15)

- Each comparison can switch between branch changes (three-dot) and tip-to-tip
  (two-dot) diffs; tip-to-tip comparisons are labelled in the tree.
- Empty Files sections explain whether both references resolve to the same
  commit or the target has no unique changes, and suggest swapping or changing
  mode when appropriate.

### Comparison reveal reliability (2026-07-16)

- Hierarchy-aware Tree View parents allow VS Code to reveal, select, and
  expand newly created comparisons reliably.

### Batch 2 — History (completed 2026-07-15)

- File History view for the active file (`git log --follow`), with per-file
  diffs, open-at-revision, and copy actions.
- Line History for the current selection (`git log -L`).

### Batch 3 — References and search (completed 2026-07-15)

- Compare tags, HEAD, typed locally resolvable revisions, and the live Working
  Tree in addition to local and remote-tracking branches.
- Commit search by message, author, SHA, or changed content, restricted to
  objects already present in the local repository.
- Native Commit Details view with full message, author/committer metadata,
  parents, and expandable changed files.

### Batch 4 — Repository navigation (completed 2026-07-15)

- Read-only Branches view with copy and compare-with-current actions.
- Read-only Worktrees view with branch/detached/lock state, path copy, and
  opening in a new VS Code window.
- Command arguments are revalidated against freshly enumerated repositories,
  references, and worktrees before use.

### Batch 5 — File annotations (completed 2026-07-15)

- Whole-file gutter blame markers with per-line author, age, summary, and SHA
  hovers, including unsaved buffers through local stdin.
- File heatmap with five tested blame-age buckets and overview-ruler markers.
- Saved-working-tree changes annotations relative to a chosen, locally
  resolved reference, including deletion-only hunks.
- Off by default, cancellable and debounced, with a 5,000-line responsiveness
  limit and no persistence of blame, diff, or selected-reference results.

### Batch 6 — Interaction surface parity (completed 2026-07-16)

- One native RefHaven submenu shared by Explorer and editor context menus.
- File History, Line History, annotations, Open at Revision, and Compare File
  with Revision available where users naturally look for them.
- Compact editor-title quick menu and richer status-bar blame actions.
- Revision and history actions exposed consistently on changed-file nodes.
- Canonical repository-relative path resolution for URI and tree-node command
  arguments, with path-limited Git comparison against the working tree.
- Native UI only, zero new dependencies, keyboard-accessible commands, and
  manifest/Extension Host coverage.

`Stash This File` remains intentionally assigned to Batch 8 because it is the
first repository mutation and requires its own recovery and security gates.

### Batch 7 — Rich local line hover (completed 2026-07-16)

- Native hover across the complete line, independent of the inline annotation.
- Full local commit identity, author/email, exact/relative date, Git timezone,
  original path/line, file count, and per-file statistics.
- Show Commit Details, Diff Previous, Diff Working Tree, Open Revision, File
  History, Line History, and copy actions.
- Lazy cancellable loading with known-workspace repository validation, a
  64-entry document-version/line cache, and watcher-driven invalidation.
- Compact local previous-revision patch with a 64 KiB Git ceiling and a
  24-line/4,000-character presentation limit.
- Escaped trusted Markdown with a fixed command allowlist and no persistence.

Approved-GitLab links remain assigned to Batch 9 so local hover availability
never depends on network access.

## Completed — Batch 8: Safe stash workflows

- Added **Stash This File...** to editor, Explorer, Source Control, and the
  native file-actions quick menu.
- Preserves selected staged and unstaged state, including partial staging,
  deletion, and rename, while leaving unrelated worktree/index state intact.
- Uses literal validated paths, temporary index/worktree trees, standard
  two-parent stash commits, and compare-and-swap `refs/stash` updates.
- Rejects untracked, conflicted, metadata, stale-repository, and active-filter
  inputs; disables Git hooks for every mutating plumbing command.
- Refreshes RefHaven and built-in Source Control after the non-cancellable
  mutation succeeds.
- Added Open at Stash Revision, Compare with HEAD, Compare with Working Tree,
  File History, and cancellable search across the 50 most recent other stashes.
- Added real-repository tests for staged/partial/deleted/renamed/unusual paths,
  long paths, worktrees, filters, hooks, failure cases, and `apply --index`
  compatibility.

Apply, pop, drop, multi-file stash, include-untracked, and keep-index variants
remain deliberately deferred.

## Completed — Batch 9: Approved GitLab links

- Added an empty-by-default allowlist of exact HTTP(S) origins, including
  effective port validation and rejection of paths, credentials, query, and
  fragment components.
- Reads bounded remote configuration through local transport-blocked Git.
  HTTP remotes require an exact origin match; SSH/scp remotes map only by
  hostname and prompt when more than one approved browser origin is possible.
- Added explicit Open on GitLab actions for project, immutable commit,
  branch/tag/HEAD revision, comparison, file/selected lines, issue, and merge
  request. Rich and status-bar blame hovers expose the line action without
  performing remote discovery until clicked.
- Resolves every ref locally to an immutable SHA, normalizes and re-encodes
  project/file paths, validates the final origin again, strips authenticated
  remote user information by construction, and logs no URL or path.
- Uses only `vscode.env.openExternal`; RefHaven has no HTTP client, API token,
  redirect handler, automatic discovery, background request, proxy, backend,
  analytics endpoint, or third-party provider.

Direct GitLab API support for merge-request/pipeline status remains deferred.
It should be added only if the URL-only milestone proves insufficient and a
specific approved use case justifies SecretStorage and response-data handling.

## Completed — Batch 10: Comparison review experience

- Track reviewed/unreviewed files per saved comparison without modifying the
  repository.
- Show progress and provide Next/Previous Unreviewed File actions.
- Add file filtering, sorting, quick open, and keyboard-first navigation.
- Keep review state workspace-local, versioned, bounded, and invalidated
  predictably when comparison endpoints change.

Delivered in version 0.6.0 with a separate `comparisonReviews.v1` store,
SHA-256 result fingerprints, 64-record/10,000-path/256-KiB per-record limits,
a 4 MiB total ceiling, automatic orphan cleanup, and conservative Working Tree
invalidation on every recalculation.
The native tree shows reviewed progress and file state; context/title/palette
commands provide mark/reset/all-reviewed, Quick Open, Next/Previous
Unreviewed, filter, and sort. Status/change-size sorting switches to a flat
list, while tree layout restores truthful path ordering.

## Completed: Batch 11 native view enrichment

### Batch 11 — Native view enrichment

- Stashes: filtering, statistics, richer revision actions, and consistent
  tooltips.
- Commit Details: parent navigation, compare with parent, and copy individual
  metadata fields.
- File History: filtering, revision navigation, and follow-file visibility.
- Branches: upstream, ahead/behind, latest commit, and expandable local
  history.
- Worktrees: branch/HEAD details and local working-state summary.

Prefer enriching the existing native views over adding more permanent Source
Control sections.

Delivered in version 0.7.0 without new dependencies or persistent state.
Stash statistics and branch history load only when expanded; filters reuse
already loaded data. All metadata comes from bounded transport-blocked local
Git commands, and the Branches and Worktrees surfaces remain read-only.

### Maintenance hardening 0.7.1

- Hardened trusted Markdown command links for repository paths and commit
  metadata containing parentheses.
- Restored the compact inline-blame hover when rich line hover is disabled.
- Corrected unchanged original-location presentation and made the 50-stash
  search ceiling explicit.
- Revalidated both selected index and worktree snapshots immediately before
  single-file stash cleanup.
- Rejected review actions from stale comparison tree nodes instead of applying
  them to a newly calculated result.
- Serialized comparison-review writes so rapid mark/unmark actions cannot
  overwrite one another.

## Next priorities

The planned low/medium-complexity native UI roadmap is complete. Select the
next batch from measured user feedback rather than adding another permanent
Source Control view. Prefer refinements to the six existing views and keep the
items below deferred unless a specific workflow justifies their cost.

## Deliberately deferred

- **Commit graph webview** — high layout, rendering, accessibility, and
  maintenance cost; revisit only on strong demand.
- **Custom Webview UI** — native VS Code UI remains the default unless a
  specific workflow cannot be represented accessibly with native APIs.
- **Git CodeLens** — per-symbol blame is performance-sensitive; revisit after
  the rich line hover has been measured in real repositories.
- **Automatic fetch/push** — not required for the first GitLab integration and
  must not be introduced as implicit background activity.
- **Third-party AI review or enrichment** — incompatible with the approved
  data-processing boundary unless the organisation later approves a specific
  provider.
- N-way comparisons, cross-repository comparison, recursive submodule
  management, and a complete replacement for VS Code's Git client.

## Working agreements

- Keep the layered architecture: typed Git plumbing with tested parsers in
  `infrastructure/git`, orchestration in `application`, native tree/editor
  presentation in `ui`, and VS Code-free types in `domain`.
- Prefer platform APIs and the Git executable already trusted by the
  organisation; production dependencies remain prohibited by default.
- Every mutation command needs real-repository integration tests and a written
  failure/recovery contract.
- Every networked feature needs an explicit data-flow review, approved-host
  enforcement, redaction tests, and a no-network degradation test.
- Update `PRODUCT.md`, `ARCHITECTURE.md`, `SECURITY.md`, `TEST-MATRIX.md`, and
  this roadmap whenever the shipped security boundary or a batch changes.
