# Roadmap

RefHaven is growing toward a GitLens-style feature set while staying a
native-UI, no-webview, no-telemetry extension. Features are chosen for high
user value at low-to-medium implementation effort and are delivered in
verifiable batches: each batch compiles, lints, passes unit and extension
tests, and packages before it merges to `master`.

## Delivered

### Rich comparison UI (merged 2026-07-15)

- Persistent, directional branch comparisons with pin, swap, refresh, close.
- Ahead/Behind commit sections with paging; commits expand to the files they
  changed (first-parent diff; root commits diff against the empty tree).
- Changed files as a flat list or compacted folder tree with SCM-style status
  decorations, diff stats, and rich tooltips.
- Native readonly diffs through a shared `FileDiffScope`, reused by
  comparisons, single commits, and stashes.
- Read-only Stashes view: list per repository, expand to files, native diffs,
  refresh, and copy actions. Mutations are excluded by the local-only policy.
- File context actions: Open File, Copy Path, Copy Relative Path; commit
  context actions: Copy SHA, Copy Commit Message.

### Batch 1 — Editor intelligence (completed 2026-07-15)

- Current-line inline blame with dimmed end-of-line text (works in dirty
  buffers via `git blame --contents -`).
- Rich blame hover with Copy SHA / Copy Message / Open File at This Revision
  command links; status-bar blame with a quickpick of the same actions.
- `refhaven.inlineBlame.enabled` and `refhaven.statusBarBlame.enabled`
  settings plus a Toggle Inline Blame command.
- Open File at Revision command (interactive branch picker or direct
  invocation from blame links).
- Auto-refresh: a `.git` metadata watcher refreshes comparisons, stashes, and
  blame after commits, branch switches, fetches, and stash operations.

### Security and reliability hardening (2026-07-15)

- Local-only Git execution policy with a process scheduler, timeouts, and
  cancellation via AbortSignal end to end; stash mutations removed.
- Signed revision URIs, path identity normalization, worktree-aware `.git`
  metadata watching, bounded caches, and Markdown escaping of Git-controlled
  text.

### Comparison mode switching and empty-state clarity (2026-07-15)

- Change Comparison Mode command: each comparison can switch between branch
  changes (three-dot) and tip-to-tip (two-dot) diffs; tip-to-tip comparisons
  are labelled in the tree.
- An empty Files section now explains itself ("branches point at the same
  commit" / "target has no commits of its own") with a tooltip suggesting
  swap or a mode switch. Outcome of investigating a "0 files changed" report
  that was correct three-dot semantics, not a defect.

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

- Read-only Branches view: local and remote-tracking branches with copy and
  compare-with-current actions.
- Read-only Worktrees view: local metadata, branch/detached/lock state, path
  copy, and open in a new VS Code window.
- Command arguments are revalidated against freshly enumerated repositories,
  refs, and worktrees before they can open or persist anything.

Checkout/create/delete branch and add/remove worktree operations are excluded:
they mutate repositories and can execute repository-configured hooks or
filters. RefHaven keeps the stronger local-only, read-only security boundary.

## Planned

### Batch 5 — File annotations

Builds on Batch 1's blame infrastructure:

- Whole-file gutter blame annotations.
- File heatmap (blame age → color scale).
- Changes annotations relative to a chosen reference.

## Deliberately deferred

- **Commit graph webview** — high effort (canvas rendering, graph layout);
  conflicts with the native-UI principle. Revisit only on strong demand.
- **Git CodeLens** — per-symbol blame is performance-sensitive and widely
  disabled by users; the blame hover covers most of its value.
- **Git command palette** — largely overlaps VS Code's built-in SCM commands.
- N-way comparisons, hosted-forge/PR integration, automatic fetch, AI review
  (unchanged exclusions from [PRODUCT.md](PRODUCT.md)).

## Working agreements

- Keep the layered architecture: typed Git plumbing with tested parsers in
  `infrastructure/git`, orchestration in `application`, native tree/editor
  presentation in `ui`, VS Code-free types in `domain`.
- Update [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md), and this
  roadmap whenever a batch lands.
