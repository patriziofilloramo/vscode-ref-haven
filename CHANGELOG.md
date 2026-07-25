# Changelog

All notable changes to RefHaven are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

RefHaven has not been published to the Visual Studio Marketplace yet, so the
entries below are development milestones rather than public releases.

## [0.11.0] — 2026-07-18

### Added

- Merge forecast: every comparison between immutable endpoints shows whether
  merging the target into the base would conflict. Conflicts appear on the
  comparison row with the conflicted paths in the tooltip. The forecast is
  computed in memory with `git merge-tree --write-tree` and never touches the
  worktree, index, or any ref. Requires Git 2.38 or newer; older versions
  degrade silently to no forecast.
- A data-egress guard in the test suite that fails the build if any source
  file gains a network call, a code-execution primitive, telemetry, or an
  unaudited process or browser handoff.
- A shareable data-security attestation in English, German, and Italian, with
  a landing page for publishing the documentation folder.
- The project's own shield-and-branch mark as the extension icon.

### Changed

- The Git executable is now resolved to an absolute path once per session,
  from the configured `git.path` or the absolute entries on `PATH`, instead of
  being invoked by name. Relative and empty `PATH` entries are skipped.
- Exported patches are read as raw bytes, so content in a legacy or mixed
  encoding survives verbatim and a saved patch applies cleanly. The export
  ceiling is raised to 64 MiB.
- Opening or copying a GitLab URL now names the exact origin used.
- The project carries its public identity: MIT license, a real publisher, and
  repository, homepage, and issue metadata. Packaged builds are written to
  `build/` instead of the repository root.

### Fixed

- The composite Repository and Inspector views report tree ancestry only where
  it is exact, instead of claiming an incorrect parent for nested nodes.

## [0.10.1] — 2026-07-16

### Added

- A privacy notice and an implementation-provenance record, both shipped in
  the package.
- A dependency-free release-readiness gate that blocks public packaging until
  ownership, license, publisher, repository, support, and homepage metadata
  are present, and that rejects accidental third-party product branding.

## [0.10.0] — 2026-07-16

### Changed

- Consolidated six Source Control sections into four focused views: Branch
  Comparisons, Stashes, Inspector, and Repository.

### Added

- Explicit loading, refreshed-at, stale, and error states on comparisons, plus
  an unreviewed-file badge.
- **Open All Changes**, which opens every text change in one native editor.

## [0.9.0] — 2026-07-16

### Added

- A Command Palette fast path for enabling or clearing a strict GitLab browser
  origin.
- Copy actions for GitLab project, commit, branch, comparison, and file URLs,
  through the same validation boundary as opening them.
- **Stash This File...** and **Inspect Current Line** in Source Control,
  file-to-comparison reveal, and two-branch multi-selection comparison.

### Changed

- Routine clipboard confirmations moved from popups to the status bar.

## [0.8.2] — 2026-07-16

### Changed

- Separated bounded Git process execution from typed Git operations, and
  centralized runtime settings, input limits, and object-ID validation.
- Hardened operational logging so exception messages and repository-derived
  metadata cannot reach the output channel.

### Added

- Workspace-trust and virtual-workspace declarations, and an architectural
  quality gate.

## [0.8.1] — 2026-07-16

### Changed

- With no configured origin, GitLab browser origins are derived from validated
  local remotes. Configuring an origin activates the strict allowlist. No
  network discovery, API client, or token was introduced.

## [0.8.0] — 2026-07-16

### Added

- **Rename Comparison**, giving any saved comparison a meaningful display name.
- Autolinked `#issue` and `!merge-request` references in commit summaries and
  messages, which open through the existing origin policy only when clicked.
- Time-travel blame: the rich hover works inside readonly revision documents
  and can open the file as it was before the blamed commit.
- Patch export for a whole comparison or a single changed file.

## [0.7.1] — 2026-07-16

### Fixed

- Trusted Markdown command links survive repository paths and commit metadata
  containing parentheses.
- The compact inline-blame hover returns when the rich line hover is disabled.
- Single-file stash revalidates the selected index and worktree snapshots
  immediately before cleanup.
- Review actions from a stale comparison node no longer apply to a freshly
  calculated result, and rapid mark/unmark actions cannot overwrite each other.

## [0.7.0] — 2026-07-16

### Added

- Filtering and statistics for stashes, parent navigation and metadata copying
  for commit details, revision navigation for file history, upstream and
  divergence details for branches, and working-state summaries for worktrees.

## [0.6.0] — 2026-07-16

### Added

- Comparison review: mark files reviewed or unreviewed, see progress, jump to
  the next or previous unreviewed file, and filter, sort, or quick-open the
  changed files. Review state is workspace-local, bounded, and invalidated when
  the comparison endpoints change.

## [0.5.0] — 2026-07-16

### Added

- Explicit GitLab browser links for project, commit, branch or tag revision,
  comparison, file and selected lines, issue, and merge request. Every
  reference resolves to a local immutable SHA and the final URL is validated
  again before it is handed to the browser.

## [0.4.0] — 2026-07-16

### Added

- **Stash This File...**, which stashes the staged and unstaged state of one
  tracked file while leaving every unrelated change intact. Untracked,
  conflicted, metadata, and filtered paths are rejected, and Git hooks are
  disabled for the operation.
- Stash file actions: open at stash revision, compare with HEAD, compare with
  the working tree, and search recent stashes for a file.

## [0.3.0] — 2026-07-16

### Added

- A rich line hover with author and email, exact and relative dates, the full
  commit identity, the original path and line, file statistics, and a bounded
  previous-revision patch, plus actions for details, diffs, history, and copy.

## [0.2.0] — 2026-07-16

### Added

- One native RefHaven submenu shared by the Explorer and editor context menus,
  a compact editor-title menu, and consistent revision, history, open, and copy
  actions on changed-file nodes.
- **Compare File with Revision...**, a path-limited native diff between a local
  reference and the working-tree file.

## [0.1.0] — 2026-07-15

### Added

- Persistent, directional branch comparisons with pin, swap, refresh, close,
  and a choice between branch-changes and tip-to-tip diffs.
- Ahead/Behind commit sections, changed files as a list or compacted tree, and
  native readonly diffs for comparisons, commits, and stashes.
- Current-line inline blame and a status-bar entry, both working in unsaved
  buffers.
- File history, line history, commit search, commit details, and read-only
  branch and worktree views.
- Opt-in whole-file annotations: blame, an age heatmap, and changes relative to
  a chosen local reference.
- A restricted local Git execution boundary with transport blocking, a process
  scheduler, timeouts, output limits, and cancellation; signed revision URIs;
  and a prohibition on production dependencies.
