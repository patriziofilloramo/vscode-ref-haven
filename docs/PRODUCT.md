# RefHaven product definition

## Mission

RefHaven is a Visual Studio Code extension dedicated to persistent, directional comparisons between Git branches. It deliberately focuses on the Search & Compare / Compare References use case rather than attempting to reproduce a complete Git client.

The product lets users create several comparisons, view them together, keep them across reloads, refresh them as refs move, inspect commits and changed files, and open file changes in VS Code's native diff editor.

## Product language

A comparison has a baseline (`baseRef`) and the branch being analysed (`targetRef`). The UI describes this direction explicitly:

> `feature/oauth relative to main`

`ahead` means commits reachable from the target but not the base. `behind` means commits reachable from the base but not the target. Domain code and documentation use `baseRef`, `targetRef`, `ahead`, `behind`, `comparison`, `comparison result`, and `saved comparison` consistently. Symmetric labels and alternative names such as left/right or source/destination are not used in the domain model.

## Saved comparison model

Every created comparison is saved automatically in the current workspace and remains until explicitly closed. Pinning affects priority and ordering, not persistence.

The extension stores comparison configuration in
`ExtensionContext.workspaceState`, under `refhaven.comparisons.v1`. Bounded
per-comparison reviewed-file markers use the separate versioned key
`refhaven.comparisonReviews.v1`. Neither is written to the repository, `.git`,
workspace settings, or another committable file. Computed Git results are
never persisted.

```ts
interface SavedComparisonV1 {
  schemaVersion: 1;
  id: string;
  repository: {
    workspaceFolderUri: string;
    relativeRepositoryPath: string;
  };
  baseRef: {
    fullName: string;
    displayName: string;
    kind: "head" | "localBranch" | "remoteBranch" | "revision" | "tag";
  };
  targetRef: {
    fullName: string;
    displayName: string;
    kind: "head" | "localBranch" | "remoteBranch" | "revision" | "tag" | "workingTree";
  };
  mode: "branchChanges" | "tipToTip" | "workingTree";
  customLabel?: string;
  pinned: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
}
```

IDs are UUIDs, allowing multiple independently configured comparisons for the same pair of refs.

On activation, saved nodes are restored immediately as `notComputed`; restoration does not wait for Git. Visible or expanded comparisons are computed lazily. Missing repositories or refs remain saved and appear as recoverable errors.

## Version 0.1 scope

Version 0.1 includes:

- create, edit, swap, refresh, pin, reorder, and close comparisons;
- refresh all and close-unpinned/repository actions;
- automatic workspace-scoped persistence and restore;
- one or many repositories, including multi-root workspaces, repositories discovered by VS Code, and nested repositories already known to the built-in Git extension;
- local and locally available remote-tracking branches;
- resolved base and target SHAs, merge base, ahead/behind counts and paginated commit lists;
- changed files with added, modified, deleted, renamed, copied, type-changed, and applicable unmerged states;
- additions/deletions when available and explicit binary handling;
- `branchChanges` and `tipToTip` modes;
- native readonly revision documents and the native VS Code diff editor;
- not-computed, loading, ready, stale, missing repository/ref, no-common-ancestor, and Git-failure states;
- cancellation, stale-result prevention, bounded concurrency, and SHA-keyed caching.

Version 0.1 explicitly excluded N-way comparisons, working-tree comparisons, merge/rebase/cherry-pick/patch operations, staging or file modification, hosted-forge integration, pull requests, automatic fetch or authentication, unfetched remote branches, custom diff/editor UI, AI review, cross-repository comparison, recursive submodule handling, general commit search, blame, and a full repository graph. Several of these exclusions have since been delivered deliberately; the current plan lives in [ROADMAP.md](ROADMAP.md).

## Beyond version 0.1

The product has since grown into a broader local Git investigation workspace
while keeping the native-UI, no-webview, no-telemetry principles:

- **Commit drill-down:** commits in the Ahead/Behind sections expand to the files they changed and open per-commit diffs (first parent; root commits diff against the empty tree).
- **Comparison mode switching:** each saved comparison can switch between `branchChanges` (three-dot) and `tipToTip` (two-dot) diffs via _Change Comparison Mode..._; tip-to-tip comparisons are labelled in the tree. When a three-dot comparison legitimately has no files — the target has no commits of its own, or both refs point at the same commit — the Files section states the reason and its tooltip suggests swapping the direction or switching mode.
- **Comparison review:** changed files can be marked reviewed/unreviewed with
  progress on the comparison and Files section. Next/Previous Unreviewed,
  Quick Open, all/reviewed/unreviewed filtering, and path/status/change-size
  sorting provide a keyboard-first review loop without changing Git state.
  Review markers are workspace-local, bounded, and tied to a fingerprint of
  the current result; Working Tree markers reset on recalculation.
- **Merge forecast:** each comparison between immutable endpoints shows
  whether merging the target into the base would conflict, computed in memory
  with read-only `merge-tree` plumbing. Conflicts surface on the comparison
  row with the conflicted paths in the tooltip; clean merges stay quiet, and
  unsupported Git versions degrade silently to no forecast.
- **Fail-safe single-file stash and read-only inspection:** _Stash This File..._
  captures the selected tracked regular file's separate staged and unstaged
  states—or both paths of its rename—in a standard two-parent Git stash while
  excluding untracked files and leaving unrelated changes in place. Cleanup
  uses atomic evacuation, no-clobber publication, a byte-for-byte index
  compare-and-swap, and a retained recovery journal so concurrent editor or Git activity
  is preserved rather than overwritten. The Stashes view lists existing
  stashes per repository with expandable file trees, native diffs,
  copy-message, revision actions, and recent-stash search.
- **Native view enrichment:** Stashes and File History have in-memory filters;
  expanded stashes show local change statistics; file history exposes parent,
  rename-follow, and adjacent-revision navigation; Commit Details supports
  metadata copy and parent drill-down/diff; Branches show upstream divergence,
  tip metadata, and bounded expandable history; Worktrees show a local
  staged/unstaged/untracked/conflicted summary.
- **Native file-action surfaces:** the Explorer and editor share a RefHaven submenu for file/line history, annotations, open-at-revision, and compare-with-revision. The editor title and status-bar blame provide compact quick picks, while changed-file nodes expose revision, history, open, and copy actions consistently.
- **Contextual workflows:** Source Control exposes single-file stash through
  the unified RefHaven submenu, plus editor line inspection, active-file reveal
  in saved comparisons, and two-branch selection. These flows reuse the same
  validated controllers as the Command Palette instead of introducing parallel
  implementations.
- **Line blame and hover:** dimmed inline blame for the current line (including unsaved buffers via `git blame --contents -`) plus a lazy hover over any file line. The hover shows author/email, original location, full commit identity, local commit statistics, a bounded previous-revision patch, and native actions for details, diffs, history, revision opening, and copy.
- **File annotations:** opt-in whole-file gutter blame, a five-bucket commit-age heatmap, and saved-working-tree change ranges relative to a locally resolved reference. Computation is cancellable, bounded to 5,000 editor lines, and never persisted.
- **File history:** an active-file Source Control view backed by `git log --follow`, with native per-revision diffs, rename tracking, copy actions, and open-at-revision.
- **Line history:** a selection-aware quickpick backed by `git log -L`, opening the selected historical revision locally.
- **Flexible local references:** comparisons accept branches, tags, HEAD, typed locally resolvable revisions, and the live Working Tree; typed revisions are resolved and persisted as immutable SHAs.
- **Commit search and details:** local history can be searched by message, author, SHA, or changed content, with full metadata and changed files shown in a native tree view.
- **Open File at Revision:** open a readonly revision of the active file from a branch picker or directly from blame links.
- **Automatic refresh:** a watcher on each repository's `.git` metadata (HEAD, refs, reflog) refreshes comparisons, stashes, and blame after commits, branch switches, fetches, and stash operations, complementing the manual refresh commands.
- **GitLab browser links:** validated local remotes enable zero-config explicit
  browser actions for project, commit, local branch/tag/HEAD revision,
  comparison, file/line, issue, and merge request. Validated target URLs may
  also be copied without opening a browser. A non-empty exact-origin list
  activates strict allowlist enforcement, and one origin can be configured or
  cleared from the Command Palette. All ref links use locally resolved SHAs;
  no HTTP request, API token, background discovery, or RefHaven service
  exists.
- **GitLab autolinks:** `#issue` and `!merge-request` shorthand in commit
  summaries and full commit messages becomes inert command links that run the
  validated origin-policy flow only when clicked. Word-adjacent, zero-padded,
  path-like, and HTML-entity-like candidates never linkify.
- **Time-travel blame:** the rich line hover also works on readonly revision
  documents and blames at their pinned SHA. _Before This Change_ opens the file
  just prior to the blamed commit, so repeated hovers walk a line's history.
- **Comparison names and patch export:** _Rename Comparison..._ stores a
  per-comparison display name (empty restores the default), while
  _Copy Patch_ / _Save Patch..._ and the per-file _Copy File Patch_ export
  locally produced unified diffs for sharing outside the workspace.

All file diffs — comparison, commit, and stash — open through one shared `FileDiffScope` describing the two revisions, so every surface reuses the same native readonly diff pipeline.

## User experience

The extension contributes four native Source Control views: Branch
Comparisons, Stashes, Inspector (File History and Commit Details), and
Repository (Branches and Worktrees). It uses native commands, context menus,
theme icons, keyboard navigation, and accessibility support; it does not use a
Webview.

Comparisons are grouped by repository only when more than one repository is present. A comparison node displays its directional label and a compact summary such as `↑8 ↓2 · 14 files`. Its tooltip includes repository, full refs, mode, resolved SHAs, merge base, and update time, without credentials or file contents.

When files exist, the comparison summary also shows reviewed/total progress.
Reviewed files use a native pass icon and retain the same
diff/open/history/copy actions. Review-only context actions are contributed
only to saved-comparison file nodes, not to stash, commit-details, or history
nodes.

The main flows are:

1. **New Comparison:** choose a repository when needed, base branch, target branch, and mode; save, reveal, expand, and compute it.
2. **Compare Current Branch With...:** use the current branch as target, ask only for a base, and default to `branchChanges`. Detached HEAD produces an explanatory message.

Reference pickers group special refs, local branches, remote-tracking refs, and tags. They display short names while retaining full names; typed revisions must resolve locally and are canonicalized to a SHA before persistence. Commit section labels state direction explicitly, for example `Commits only in feature/oauth`; the initial page size is 50.

Inline actions are Refresh, Swap, Edit, Pin/Unpin, and Close. The context menu additionally supports changing mode, copying a summary, closing all unpinned comparisons, and closing comparisons for a repository.

File actions resolve the selected URI or changed-file node to a canonical
repository-relative Git path immediately before use. Comparing a file with a
reference performs a path-limited local diff and opens the shared native
revision pipeline; it does not calculate or retain an entire repository diff.
The same submenu accepts VS Code Git Source Control resource objects. Stash
creation prompts for a message, saves a dirty selected editor only after the
user confirms that message, re-resolves the target, runs as a non-cancellable
bounded mutation, and refreshes both RefHaven and built-in Source Control
whenever a stash was published. A failed save stops before Git is mutated. A
successful evacuation offers its retained safety directory. If
concurrent activity prevents cleanup after publication, the UI distinguishes
that outcome from total failure, identifies the created stash, leaves the
newer state untouched, and offers the same directory for manual recovery.

Rich line hovers are computed only when VS Code requests them. Results are
cached by document version and line in a 64-entry in-memory LRU, cleared on
repository refresh, and never persisted. Patch loading has a 64 KiB Git output
ceiling and the rendered preview is further limited to 24 lines and 4,000
characters.

## Refresh behaviour

Repository events mark affected comparisons stale but are not treated as the sole source of truth. The extension rechecks visible comparisons when the window regains focus or the view becomes visible. Manual refresh is always available. It does not continuously poll while VS Code is in the background.

File saves and VS Code create, delete, or rename operations invalidate mutable
Working Tree results. Staging and unstaging are observed through the Git index
watcher. These events only mark cached results stale; recalculation remains
lazy and scheduler-bounded.

Refresh is generation-based and cancellable. At most two Git processes run concurrently per repository and four globally. In-flight work is cancelled when its comparison is refreshed, replaced, or closed. Computed comparison and commit results remain cached while their active tree state is valid; readonly revision content uses a bounded LRU cache.

## Privacy, safety, and limits

The extension has no telemetry, runtime dependency, HTTP/API client, Git remote
operation, or automatic fetch. Git is launched without a shell and with
argument arrays. Every invocation blocks protocols and partial-clone lazy
fetch, disables prompts and tracing, removes inherited Git redirection, and
prevents configured fsmonitor/diff/textconv helpers. Paths are literal, not
Git patterns. The stash mutation saves a confirmed dirty selected buffer before
entering the Git boundary, disables Git hooks, and rejects active content
filters, sparse checkout, conflicts, special entries, symlinks/gitlinks,
skip-worktree state, files over 64 MiB, and cross-device recovery boundaries
before publishing. It atomically publishes
`refs/stash` plus a private recovery ref with a compare-and-swap, atomically evacuates the original path to
repository-local Git metadata, installs `HEAD` without clobbering a concurrently
recreated path, and installs a prepared full index only after a byte-for-byte
compare-and-swap under the real `index.lock`. Failures after publication retain a journal and
safety copy under `<absolute-git-dir>/refhaven-recovery` and warn the user;
these retained files are not automatically deleted. A recovery ref recorded by
an incomplete journal must be deleted with its expected stash SHA before the
directory is removed. Missing local objects fail
closed. Typed revisions pass strict syntax validation and must resolve through
the transport-blocked local Git boundary before use.

GitLab browser actions work from validated local remotes without setup.
HTTP(S) remotes retain their exact origin and SSH remotes infer HTTPS on the
same hostname. A configured non-empty origin list switches to strict allowlist
enforcement and supports custom browser ports. Authenticated remote user
information is never included in the generated URL. RefHaven validates the
final origin and hands the URL to the external browser only after a user
command. Browser networking and redirects are outside the extension trust
boundary. The complete threat model is in [SECURITY.md](../SECURITY.md).

Logs contain stable event categories and non-sensitive operational metadata.
Exception messages are excluded. Metadata keys associated with authors,
branches, commit messages, emails, paths, refs, repositories, SHAs, remotes,
credentials, environment values, secrets, tokens, and file content are
redacted; Git file content is never logged.

Commands have cancellation, a configurable 1–300 second timeout, four-global/two-per-repository concurrency limits, and 5 MiB stdout/stderr limits. Unsaved blame input is capped at 5 MiB. Revision content is read only when a user opens a revision or diff, authenticated with a session-scoped URI signature, and retained in a cache bounded to 64 entries and 16 MiB.

## Delivery milestones

1. Technical spike and clean-implementation ADR.
2. Strict TypeScript extension skeleton and toolchain.
3. Tested Git core and NUL-delimited parsers.
4. Persistence-first comparison store.
5. Native comparison Tree View and commands.
6. Native immutable revision diffs.
7. Refresh lifecycle, cancellation, concurrency, and cache.
8. Cross-platform hardening and unusual repository/path cases.
9. Documentation, packaging, clean installation, and VSIX delivery.

Each implementation milestone begins with its acceptance tests and ends only after relevant unit and integration tests, lint, compilation, and packaging checks are green. Each milestone is committed independently.

## Definition of done

Version 0.1 is done when at least ten comparisons can coexist across repositories and survive reload with order and pins intact; Git semantics are correct for linear, divergent, renamed, added, deleted, binary, missing-ref, and unrelated histories; stale refreshes cannot overwrite newer work; hidden comparisons do not refresh aggressively; all creation and actions work by keyboard; comparison direction and mode remain unambiguous; and the extension is strict, tested, free of shell-interpolated commands, free of unhandled Extension Host errors, and installable as a VSIX.

Performance targets are measured rather than assumed: activation without Git computation under 150 ms on the documented reference machine, immediate saved-node restoration, no more than four global Git processes, lazy file-content loading, paginated commits, a responsive Extension Host for large comparisons, and cancellable progress for refresh-all.
