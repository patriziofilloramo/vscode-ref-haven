# Roadmap

Branch Compare is growing toward a GitLens-style feature set while staying a
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

### Batch 1 — Editor intelligence (in progress on `feat/gitlens-essentials`)

- Current-line inline blame with dimmed end-of-line text (works in dirty
  buffers via `git blame --contents -`).
- Rich blame hover with Copy SHA / Copy Message / Open File at This Revision
  command links; status-bar blame with a quickpick of the same actions.
- `branchCompare.inlineBlame.enabled` and `branchCompare.statusBarBlame.enabled`
  settings plus a Toggle Inline Blame command.
- Open File at Revision command (interactive branch picker or direct
  invocation from blame links).
- Auto-refresh: a `.git` metadata watcher refreshes comparisons, stashes, and
  blame after commits, branch switches, fetches, and stash operations.

## Planned

### Batch 2 — History

- File History view for the active file (`git log --follow`), with per-file
  diffs, open-at-revision, and copy actions.
- Line History for the current selection (`git log -L`).

### Batch 3 — References and search

- Compare arbitrary references: tags, HEAD, and typed revisions in the
  comparison pickers.
- Compare-with-working-tree mode.
- Commit search quickpick by message, author, SHA, or changed content
  (`--grep`, `--author`, `-S`).
- Commit details view (full message, metadata, files) from any commit node or
  search result.

### Batch 4 — Repository management

- Branches view: locals and remotes with checkout, create, delete, and
  compare-with-current context actions.
- Worktrees view: list, add, remove, open in new window.

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
