# Changelog

All notable changes to RefHaven are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First public release. Everything below is what RefHaven does on day one; there
is no earlier published version to compare against.

### Comparisons

- Persistent, directional branch comparisons with pin, swap, refresh, close,
  rename, and a choice between branch-changes and tip-to-tip diffs.
- Ahead/Behind commit sections, changed files as a list or compacted tree, and
  native readonly diffs for comparisons, commits, and stashes.
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
