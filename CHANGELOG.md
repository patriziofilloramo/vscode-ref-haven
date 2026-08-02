# Changelog

All notable changes to RefHaven are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.13.7] — 2026-07-30

### Changed

- Reduce Git process overhead without changing the fail-closed filter policy:
  commands that run concurrently on one repository now share a single
  filter-configuration probe, and a fixed allowlist of ref, config, attribute,
  and object plumbing that provably cannot invoke a content filter skips the
  probe entirely. Every other command keeps its own probe and neutralization.
- Report filter-probe duration and sharing at debug level in the RefHaven
  output channel so the remaining per-command overhead can be observed.

## [0.13.6] — 2026-07-30

### Security

- Prevent repository-configured content filters, text-conversion commands, and
  merge drivers from being executed by RefHaven's local Git inspections.
- Fail closed when the Git executable cannot be resolved to an absolute path,
  and reject repository roots above the trusted workspace boundary.
- Revalidate persisted comparisons against the current workspace before they
  can calculate, export, copy, or open repository data.
- Reject traversal on every host and enforce device-name, alternate-stream,
  trailing-dot, and trailing-space restrictions on Windows without rejecting
  valid POSIX repository names.
- Reject working-tree operations on paths with active content filters instead
  of returning approximate results while executable drivers are neutralized.

### Fixed

- Keep immutable revision comparisons available when a Git tree contains names
  that the current host cannot materialize, while continuing to reject those
  paths before every working-tree or filesystem operation.
- Run Extension Host tests with a fresh, locally owned Git fixture and isolated
  user profile, and clear compiled test output so stale or restored sessions
  cannot cause misleading failures.
- Keep `private: true` as the npm publication safeguard while allowing the VSCE
  marketplace readiness gate to package a public release.
- Restore **Stash This File...** with a fail-safe transaction that preserves
  the selected file's staged and unstaged state in a standard two-parent Git
  stash while leaving unrelated and untracked changes intact. A detected
  rename is stored as its old/new path pair, and `refs/stash` is published with
  an expected-old-value compare-and-swap.
- Keep **Stash This File...** functional and singular inside the unified
  RefHaven file-actions submenu, including Source Control resources.
- Resolve deleted Source Control resources even when their parent directory no
  longer exists, hide file actions on Explorer folders, and save dirty text or
  notebook documents only after the stash message is confirmed.
- Replace unconditional working-tree restore with an atomic move into a
  same-filesystem safety directory followed by exclusive, no-clobber
  publication of the clean `HEAD` file. Remove the selected staged delta with
  a raw full-index compare-and-swap under the real `index.lock`, so a concurrent
  save or stage is never replaced.
- Retain durable, repository-local recovery journals and safety copies under the
  repository's Git metadata whenever an existing file is evacuated. If HEAD,
  the selected index entry, or the working-tree path changes concurrently,
  RefHaven stops cleanup, preserves the newer state, reports the created stash,
  and offers the recovery directory for manual inspection. A private recovery
  ref keeps an incomplete stash reachable until explicit cleanup. A concurrent stash
  update before publication loses the compare-and-swap and leaves the selected
  file untouched.
- Count only unfinished recovery records against the bounded recovery scan, so
  retained safety copies from completed operations do not disable later stashes.
- Refresh nested-repository topology without activating VS Code's Git extension
  and reject repository actions that race with workspace removal.
- Preserve cached immutable comparison results when repository discovery updates
  which saved comparisons are available.

### Changed

- Move development tooling from end-of-life Node 20 to the maintained Node 22
  and Node 24 LTS lines.
- Open the stash message prompt for a dirty selected editor and save that
  document only after confirmation; fail closed if the save cannot complete.
  Continue to reject untracked or conflicted paths, active content filters,
  sparse checkout, special index entries, symlinks/gitlinks, oversized files,
  and filesystems that cannot provide the required atomic rename and hard-link
  guarantees.

## [0.13.5] — 2026-07-25

First public release. Everything below is what RefHaven does on day one; there
is no earlier published version to compare against.

### Comparisons

- Persistent, directional branch comparisons with pin, swap, refresh, close,
  rename, and a choice between branch-changes and tip-to-tip diffs.
- Ahead/Behind commit sections, changed files as a list or compacted tree, and
  native readonly diffs for comparisons, commits, and stashes.
- Working-tree comparisons stay fresh on their own: saving, creating, deleting,
  or renaming a file, staging or unstaging from any tool, and returning focus
  to the window all mark the affected comparisons stale, which recalculate
  lazily when expanded.
- Review tracking: mark files reviewed, jump to the next or previous unreviewed
  file, and filter, sort, or quick-open the changed files. Review state is
  workspace-local and is invalidated when the comparison endpoints change.
- Merge forecast: whether merging the target into the base would conflict,
  computed in memory with `git merge-tree --write-tree`, never touching the
  worktree, index, or any ref. Requires Git 2.38 or newer and degrades silently
  on older versions.
- Patch export for a whole comparison or a single changed file.

### Blame and history

- Current-line inline blame, a status-bar entry, and a rich line hover with the
  commit message, the diff section that produced the hovered line, file
  statistics, and actions for details, diffs, history, and copy. Both work in
  unsaved buffers.
- Every blame surface names the clock time of the change, not only how long
  ago it was: "2 hours ago" cannot separate two commits an hour apart, and the
  precision shown adapts to distance — the clock alone for today, the date
  within the year, the year beyond it.
- Time-travel blame: the hover works inside readonly revision documents and can
  open the file as it was before the blamed commit.
- File history, line history, commit search, commit details, and read-only
  branch and worktree views.
- Opt-in whole-file annotations: blame, an age heatmap, and changes relative to
  a chosen local reference.

### Coexistence with other extensions

- **Line Intelligence**, one command that sets the three per-line surfaces
  together: full, hover only, or off. VS Code draws every extension's
  decorations and merges every extension's hovers, so a second blame extension
  doubles them rather than replacing them; "hover only" removes the overlap in
  one gesture and keeps the hover.
- A single dismissible notice, shown at most once, when another installed
  extension contributes a blame surface. Detection reads what extensions
  declare, never who publishes them, and nothing is changed without asking.

### Stashes

- **Stash This File...**, which stashes the staged and unstaged state of one
  tracked file while leaving every unrelated change intact. Untracked,
  conflicted, metadata, and filtered paths are rejected, and Git hooks are
  disabled for the operation.
- Open at stash revision, compare with HEAD, compare with the working tree, and
  search recent stashes for a file.

### Browser links

- Open or copy a project, commit, comparison, branch revision, file, issue, or
  merge/pull request URL. Every reference resolves to a local immutable SHA and
  the final URL is validated again before it is handed to the browser.
- GitHub, GitLab, Bitbucket, and Gitea/Forgejo/Codeberg each get their own URL
  grammar, detected from the remote hostname alone. Where a correct link cannot
  be built — any Azure DevOps target, a Bitbucket comparison — no link is
  offered rather than one that opens an empty page.
- Origins are derived from validated local remotes by default;
  `refhaven.browserLinks.approvedOrigins` switches to a strict allowlist, and
  `refhaven.browserLinks.hostGrammar` states the URL shape outright when
  hostname detection cannot infer it.

### Security and boundaries

- A restricted local Git execution boundary: transport blocking, an absolute
  Git binary resolved once per session, a process scheduler, timeouts, output
  limits, cancellation, signed revision URIs, and no production dependencies.
- A data-egress guard in the test suite that fails the build if any source file
  gains a network call, a code-execution primitive, telemetry, or an unaudited
  process or browser handoff.
- Workspace-trust and virtual-workspace declarations, a privacy notice, an
  implementation-provenance record, and a data-security attestation in English,
  German, and Italian.
