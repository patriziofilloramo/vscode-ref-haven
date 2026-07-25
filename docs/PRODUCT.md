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

The extension stores configuration only in `ExtensionContext.workspaceState`, under `refhaven.comparisons.v1`. It does not write comparison configuration to the repository, `.git`, workspace settings, or another committable file. Computed Git results are never persisted.

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

The product has since grown toward a GitLens-style feature set while keeping the native-UI, no-webview, no-telemetry principles:

- **Commit drill-down:** commits in the Ahead/Behind sections expand to the files they changed and open per-commit diffs (first parent; root commits diff against the empty tree).
- **Comparison mode switching:** each saved comparison can switch between `branchChanges` (three-dot) and `tipToTip` (two-dot) diffs via _Change Comparison Mode..._; tip-to-tip comparisons are labelled in the tree. When a three-dot comparison legitimately has no files — the target has no commits of its own, or both refs point at the same commit — the Files section states the reason and its tooltip suggests swapping the direction or switching mode.
- **Read-only stash inspection:** a dedicated Stashes view in Source Control lists stashes per repository with expandable file trees, native diffs, and copy-message. Mutation is excluded to prevent execution of repository-configured filters or merge drivers.
- **File and commit context actions:** Open File, Copy Path, Copy Relative Path, Copy Commit SHA, and Copy Commit Message from any file or commit node.
- **Line blame:** dimmed inline blame for the current line (including unsaved buffers via `git blame --contents -`), a rich hover with copy and open-at-revision actions, and a status-bar entry, all governed by `refhaven.inlineBlame.enabled` and `refhaven.statusBarBlame.enabled`.
- **File history:** an active-file Source Control view backed by `git log --follow`, with native per-revision diffs, rename tracking, copy actions, and open-at-revision.
- **Line history:** a selection-aware quickpick backed by `git log -L`, opening the selected historical revision locally.
- **Flexible local references:** comparisons accept branches, tags, HEAD, typed locally resolvable revisions, and the live Working Tree; typed revisions are resolved and persisted as immutable SHAs.
- **Commit search and details:** local history can be searched by message, author, SHA, or changed content, with full metadata and changed files shown in a native tree view.
- **Open File at Revision:** open a readonly revision of the active file from a branch picker or directly from blame links.
- **Automatic refresh:** a watcher on each repository's `.git` metadata (HEAD, refs, reflog) refreshes comparisons, stashes, and blame after commits, branch switches, fetches, and stash operations, complementing the manual refresh commands.

All file diffs — comparison, commit, and stash — open through one shared `FileDiffScope` describing the two revisions, so every surface reuses the same native readonly diff pipeline.

## User experience

The extension contributes the native `refhaven.comparisons` Tree View to the Source Control container. It uses native commands, context menus, theme icons, keyboard navigation, and accessibility support; it does not use a Webview.

Comparisons are grouped by repository only when more than one repository is present. A comparison node displays its directional label and a compact summary such as `↑8 ↓2 · 14 files`. Its tooltip includes repository, full refs, mode, resolved SHAs, merge base, and update time, without credentials or file contents.

The main flows are:

1. **New Comparison:** choose a repository when needed, base branch, target branch, and mode; save, reveal, expand, and compute it.
2. **Compare Current Branch With...:** use the current branch as target, ask only for a base, and default to `branchChanges`. Detached HEAD produces an explanatory message.

Reference pickers group special refs, local branches, remote-tracking refs, and tags. They display short names while retaining full names; typed revisions must resolve locally and are canonicalized to a SHA before persistence. Commit section labels state direction explicitly, for example `Commits only in feature/oauth`; the initial page size is 50.

Inline actions are Refresh, Swap, Edit, Pin/Unpin, and Close. The context menu additionally supports changing mode, copying a summary, closing all unpinned comparisons, and closing comparisons for a repository.

## Refresh behaviour

Repository events mark affected comparisons stale but are not treated as the sole source of truth. The extension rechecks visible comparisons when the window regains focus or the view becomes visible. Manual refresh is always available. It does not continuously poll while VS Code is in the background.

Refresh is generation-based and cancellable. At most two Git processes run concurrently per repository and four globally. In-flight work is cancelled when its comparison is refreshed, replaced, or closed. Computed comparison and commit results remain cached while their active tree state is valid; readonly revision content uses a bounded LRU cache.

## Privacy, safety, and limits

The extension has no telemetry, runtime dependency, networking API, remote operation, or automatic fetch. Git is launched without a shell and with argument arrays. Every invocation blocks protocols and partial-clone lazy fetch, disables prompts and tracing, removes inherited Git redirection, and prevents configured fsmonitor/diff/textconv helpers. Missing local objects fail closed. Typed revisions pass strict syntax validation and must resolve through the transport-blocked local Git boundary before use. The complete threat model is in [SECURITY.md](../SECURITY.md).

Logs contain command category and non-sensitive operational metadata. Metadata keys associated with credentials, environment, remote URLs, secrets, tokens, and file content are redacted; Git file content is never logged.

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
