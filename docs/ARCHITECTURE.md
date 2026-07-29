# Architecture

## Architectural goals

RefHaven uses a clean, layered implementation with a native VS Code Tree View. Git mechanics, comparison semantics, persistence, orchestration, and presentation remain independently testable. Tree nodes never execute Git directly, and the Git process layer has no knowledge of comparisons or VS Code UI.

## Layers and dependency direction

```text
VS Code activation and commands
              |
              v
       application layer
       /       |       \
      v        v        v
  domain   persistence  UI adapters
      ^        ^        |
      |        |        |
      +--- Git adapters -+
```

Domain types have no VS Code dependency. Application services depend on domain interfaces. Infrastructure and UI implement ports consumed by the application layer. `extension.ts` is the composition root and performs manual dependency injection.

## Source layout

```text
src/
  extension.ts             // activation entry point
  compositionRoot.ts       // manual dependency injection and wiring
  config/                  // extension settings and runtime bounds
    extensionConfiguration.ts
    extensionConfigurationSchema.ts
  domain/                  // VS Code-free types and pure logic
    blame.ts
    commitDetails.ts
    comparison.ts
    comparisonReview.ts
    comparisonResult.ts
    fileDiffScope.ts
    gitLab.ts
    stash.ts
    validation.ts
  application/             // orchestration; owns runtime state
    BlameController.ts
    CommitDetailsController.ts
    ComparisonController.ts
    ComparisonEngine.ts
    ComparisonReviewStore.ts
    ComparisonStore.ts
    FileAnnotationsController.ts
    FileHistoryController.ts
    BrowserLinkController.ts
    Logger.ts
    RepositoryNavigationController.ts
    RepositoryWatcher.ts
    StashController.ts
    errorHandling.ts       // privacy-safe background task/error helpers
  infrastructure/
    git/                   // typed git CLI operations and tested parsers
      GitCli.ts
      GitProcess.ts        // bounded process execution
      blamePorcelain.ts
      branchRefs.ts
      commitLog.ts
      commitDetails.ts
      diffHunks.ts
      fileHistory.ts
      nameStatus.ts
      numstat.ts
      stashFile.ts          // fail-safe single-file stash orchestration
      stashFileTransaction.ts // ref/index transaction and recovery discovery
      stashFileValidation.ts  // bounded request contract
      stashFileWorktreeSafety.ts // no-clobber filesystem primitives
      stashList.ts
      worktreeList.ts
    logging/
      OutputChannelLogger.ts
  ui/
    blame/
      blamePresentation.ts // pure label/hover builders for line blame
    commands/
      commandIds.ts
      registerCommands.ts
    documents/
      GitRevisionContentProvider.ts
    format.ts
    pickers/
      comparisonPickers.ts
    tree/
      BranchesTreeProvider.ts
      ChangeDecorationProvider.ts
      ComparisonTreeProvider.ts
      CommitDetailsTreeProvider.ts
      FileHistoryTreeProvider.ts
      InspectorTreeProvider.ts
      RepositoryTreeProvider.ts
      StashTreeProvider.ts
      WorktreesTreeProvider.ts
      changeNodes.ts       // file/folder/message nodes shared by all trees
      fileTree.ts
test/
  unit/
  extension/
```

The Source Control surface has four permanent views. `InspectorTreeProvider`
composes File History and Commit Details; `RepositoryTreeProvider` composes
Branches and Worktrees. They delegate loading and rendering to the existing
providers, so consolidation does not duplicate Git queries or parsing logic.

## Domain and runtime state

The persisted object is the versioned `SavedComparisonV1` configuration defined in [PRODUCT.md](PRODUCT.md). Runtime results are separate:

```ts
type ComparisonStatus = "notComputed" | "loading" | "ready" | "stale" | "error";

interface ComparisonRuntimeState {
  specification: SavedComparisonV1;
  status: ComparisonStatus;
  generation: number;
  result?: ComparisonResult;
  error?: ComparisonError;
}

interface ComparisonResult {
  repositoryRoot: string;
  base: ResolvedRef;
  target: ResolvedRef;
  mergeBaseSha?: string;
  aheadCount: number;
  behindCount: number;
  aheadCommits: CommitPage;
  behindCommits: CommitPage;
  files: FileChange[];
  additions?: number;
  deletions?: number;
  computedAt: number;
}
```

Resolved refs include full name, display name, and SHA. Saved refs remain symbolic; SHA values exist only in computed results and immutable revision URIs.

Process-control failures use stable codes for `commandTimedOut`, `commandCancelled`, and `outputTooLarge`. Domain operations replace other Git failures with safe, operation-specific messages before they reach the comparison tree.

## Components

### Git CLI and scheduler

`GitProcess.ts` is the only child-process execution adapter. It launches `git`
with `execFile`, argument arrays, and no shell. Every operation runs through
`GitScheduler`, which enforces four global and two per-repository processes.
The adapter owns cancellation, centrally configured timeouts, encoding, 5 MiB
stdout/stderr limits, stdin bounds, and stable process-control errors.

The Git executable is resolved to an absolute path once and memoized:
`gitBinary.ts` prefers the user's configured `git.path`, then probes only the
absolute directories on `PATH` (skipping empty and relative entries, so a
current-directory `git` cannot win). Resolution fails closed when no absolute
executable is available; it never reverts to a bare name that would repeat the
unsafe lookup. The pure selection is host-independent and unit-tested; the
buffer path also accepts a larger output ceiling for patch export.

`GitCli.ts` owns typed Git operations, command construction, validation, and
parser selection. Keeping process mechanics separate prevents the command
adapter from becoming the implicit owner of configuration, scheduling, and
platform error normalization.

Commit logs, file history, branch details, stash metadata, and full commit
details use fixed NUL-delimited formats. NUL is the framing boundary because
Git excludes it from identities, messages, refs, and paths; other control
characters remain valid data. Decimal Git timestamps pass through one strict
validator and must fit the JavaScript `Date` range before entering the domain.

`gitProcessPolicy.ts` is the single local-only process boundary. It blocks
every Git transport and lazy object fetch, disables
prompts/pagers/tracing/fsmonitor/optional locks/replace objects, removes
inherited repository and command-config redirection, and enables literal
pathspec handling. Before every string, buffer, temporary-index, or stdin
invocation, `GitProcess.ts` uses a read-only bounded config query to enumerate
effective content-filter drivers. The requested command then receives
command-scoped overrides that clear every discovered `clean`, `smudge`, and
`process` command and make the filter optional; malformed or excessive output
fails closed. Diff, blame, and content-search operations additionally pass
Git's explicit external-diff/textconv opt-outs. A strict `check-attr --stdin -z`
guard rejects working-tree paths with active content filters, so driver
neutralization never becomes a silently approximate result. Exact unit and
Extension Host marker regressions cover this boundary.

### GitClient

Provides typed operations for repository probing, branch listing, ref resolution, merge base, ahead/behind, commit pages, changed files, numstat, and on-demand object content. It owns Git command construction and parser selection while preserving the normative ranges in [GIT-SEMANTICS.md](GIT-SEMANTICS.md).

### Repository discovery

Uses the exported API of VS Code's built-in Git extension only when that
extension is already active, discovering known repositories including nested
repositories without activating a component that may be configured for
autofetch. Repository roots must equal or descend from a current trusted
workspace folder; an ancestor repository is never authorized merely because a
subfolder was opened. Repository identity combines workspace folder URI and
repository path relative to it; path identity is case-sensitive except on
Windows, and worktrees remain distinct even when they share a common Git
directory.

If `vscode.git` is unavailable, discovery probes each workspace folder with `git rev-parse --show-toplevel` and supports at least one repository per folder. The CLI remains the authority for comparison calculations.

### ComparisonStore

Reads and writes `refhaven.comparisons.v1` in `workspaceState`. It strictly
validates the complete schema, rejects malformed repository paths and branch
refs, removes duplicate logical identities and IDs, and implements create,
update, delete, and pin operations. Mutations run through one promise queue so
every read-modify-write starts from the last persisted state; colliding order
values from concurrent creation are moved to the next available order. It
sorts pinned comparisons first while preserving explicit order within pinned
and unpinned groups.

Persisted comparisons remain stored when a workspace folder is removed, but
the controller hides them immediately and revalidates the repository against
fresh discovery before every calculation, export, copy, or document-opening
action. They become visible again only if the same repository returns to the
trusted workspace.

### ComparisonReviewStore

Stores review markers separately under `refhaven.comparisonReviews.v1`; the
saved comparison schema remains unchanged. Each version-one record contains
one comparison ID, a SHA-256 revision key, sorted repository-relative reviewed
paths, and an update timestamp. Records are strictly validated, deduplicated,
limited to 64 comparisons, 10,000 paths and 256 KiB each, capped at 4 MiB
overall, and pruned for comparisons that no longer exist.

The revision key hashes immutable diff endpoints plus canonical changed-file
identity, status, and statistics, so ref movement or a changed result starts a
fresh review. A Working Tree result additionally includes its calculation
timestamp and therefore resets on every recalculation; RefHaven never claims
that mutable content remains reviewed without recomputing it. No content or
patch data enters the store.

### ComparisonEngine

Accepts a comparison specification and cancellation token, resolves both refs, computes counts and commit pages, selects the diff endpoints by mode, and combines name-status and numstat results. Working-tree comparisons keep the resolved base immutable while using the live file as the right diff side. It returns a typed result and does not call VS Code UI APIs.

For immutable endpoints the engine also requests a read-only merge forecast:
`merge-tree --write-tree` computes in memory whether merging the target into
the base would conflict, touching no worktree, index, or ref. Before invoking
it, the adapter checks every effective config scope and suppresses the forecast
if an external `merge.*.driver` exists or the check fails; renormalization is
disabled as an additional content-filter boundary. Failures and older Git
versions degrade to an absent forecast rather than an error, and Working Tree
comparisons never request one because their endpoint is mutable.

### CommitDetailsController and provider

Commit search dispatches typed, bounded local Git queries by message, author,
SHA, or changed content. Selecting a result loads full NUL-delimited metadata
and changed files into a native tree; neither search results nor commit details
are persisted. Metadata rows carry only their explicit clipboard value and
repository/SHA context. Parent rows can load the parent details or request a
single parent-to-commit file diff through the shared native diff pipeline.
Each load captures the current selection generation, repository, and commit;
selection changes and disposal abort the request, and a late completion is
discarded before it can publish mixed-context nodes. Current, non-cancellation
failures continue to the Inspector error boundary.

### ComparisonController

Coordinates store, engine, commands, and view updates. Creating a comparison persists it before calculation. Swapping persists the new symbolic configuration, cancels prior work, increments its generation, and starts a new calculation when the node is expanded.

Only a result whose captured generation equals the state's current generation may be applied. Closing a comparison cancels its work before removing it. Errors update runtime state but do not delete persisted configuration.

Review commands re-resolve the current cached/computed result before changing
state. The controller owns filter/sort preferences, quick open, review
navigation anchors, and native diff opening. Status/change-size sorts
automatically select the flat file layout; selecting tree layout restores path
sorting so the requested order remains truthful.

Rename Comparison stores a trimmed, length-capped, non-printable-character-free
display name in the persisted comparison's optional `customLabel`; an empty
input restores the ref-derived default. The storage boundary reapplies the
same invariant before accepting workspace state. Patch export re-resolves the
current result and asks `readComparisonPatch` for a bounded local `git
diff`/`git show --patch` between the already-immutable endpoint SHAs,
optionally limited to a single validated file from a known workspace
repository. The patch is read as raw bytes so content in a legacy or mixed
encoding survives verbatim: saving writes those exact bytes to a user-chosen
local filesystem location, while the clipboard receives a best-effort UTF-8
decode because it is inherently text.

### FileActionsController

The file-actions controller is the single orchestration point for Explorer,
editor, Source Control resource, editor-title, status-bar, and
changed-file-node actions. It resolves command arguments through
`ui/commands/fileContext.ts`, canonicalises the repository-relative path,
activates a working-tree editor only when required, and delegates history,
annotations, stash, revision documents, and native diffs to their owning
controllers.

Compare File with Revision resolves the selected reference to an immutable SHA
and asks Git only for the selected path. Added and deleted sides reuse the
empty revision document; unchanged files still open a valid native diff
without a repository-wide calculation.

### Refresh scheduler and cache

The scheduler enforces two concurrent Git processes per repository and four globally. Queued work is abortable, and `AbortSignal` is passed to running child processes. Repository events invalidate active results; expansion then resolves refs again. There is no background polling.

Comparison results are cached by active comparison ID and protected by a generation counter. Commit-file results are keyed by repository and commit SHA. Refresh, replacement, and close abort and remove the affected in-flight state before a stale result can be installed.

Mutable Working Tree results are invalidated on file saves, VS Code create,
delete, and rename operations, Git index changes, window focus restoration,
and comparison-view visibility. Multiple affected comparisons are invalidated
as one tree event. Invalidation remains lazy: only visible expanded nodes
recalculate, and automatic activity is logged at debug level with a bounded
count and stable operation identifier.

### Tree provider

The `TreeDataProvider` maps controller state to repository, comparison, commit-section, commit, file-section, file, error, and load-more nodes. It performs no Git operations. Repository grouping appears only for multiple repositories. Section labels preserve direction and always expose the file comparison mode.

For saved comparison files it receives a synchronous review-summary callback,
decorates reviewed files, adds progress to comparison/file-section
descriptions and tooltips, and applies the selected review filter/sort before
building shared change nodes. Commit, stash, and details file nodes remain
review-neutral.

The controller creates restored nodes synchronously in `notComputed`. Expansion or visibility requests schedule computation through the controller. `onDidChangeTreeData` updates only affected nodes where possible.

The provider implements `getParent` for comparison roots, their sections, and
commit nodes. This is part of the reveal contract: VS Code cannot reliably
select or expand a programmatically revealed node unless it can reconstruct
that node's path to the tree root.

### Revision document provider

The readonly `refhaven:` provider parses validated opaque URIs and obtains content on demand with `git show <sha>:<path>`. Every URI is authenticated with a session-scoped HMAC before parsing. Paths must be repository-relative and traversal-free; Windows filesystem restrictions apply only on Windows, so valid POSIX names remain usable. Resolved text uses a 64-entry/16 MiB LRU cache; rejected loads are not cached. An explicit empty-document URI supplies the missing side of added/deleted changes.

Renames use the old path at the from-SHA and the new path at the to-SHA. Binary files do not pass through the text provider; UI actions offer opening available revisions instead of a misleading text diff.

### Shared change nodes and FileDiffScope

`domain/fileDiffScope.ts` defines the pair of revisions a set of file changes was computed between. `ui/tree/changeNodes.ts` renders `FileChange` lists as file/folder/message nodes (flat or compacted tree) with a `FileDiffScope` attached to every file node. Comparisons, expanded commits, and stashes all produce these nodes, so one `openFileDiff` command serves every tree.

### StashController and StashTreeProvider

The stash view lists `git stash list` entries (parsed from a delimiter-safe
`--format`) per repository and expands each stash into its tracked file
changes (first parent → stash commit). File nodes expose native revision,
HEAD/working-tree comparison, history, and recent-stash-search actions.
The provider filters cached metadata in memory and records changed-file
statistics only after explicit expansion; refresh aborts and clears both
in-flight and resolved per-stash state.

`StashController` also owns the explicit **Stash This File...** mutation. The
file-action boundary resolves a canonical repository-relative target, prompts
before touching a dirty matching VS Code document, saves it after the user
confirms the stash message, and delegates the non-cancellable operation to
`infrastructure/git/stashFile.ts`. A failed save stops before the Git mutation.
The controller refreshes both RefHaven and built-in Source Control after any
published stash. A complete transaction reports its stash SHA and, when one
exists, offers the retained safety directory; an incomplete cleanup is
presented as a warning that still identifies the already-created stash and
offers the same directory.

`stashFile.ts` serializes RefHaven mutations by canonical repository identity
and implements the recovery contract independently of VS Code:

- preflight accepts only changed, tracked regular files (and the two paths of a
  detected rename), ordinary stage-zero index entries, no conflict, no active
  content filter, no sparse or skip-worktree state, no symlink/gitlink, at most
  64 MiB, and a worktree/Git safety directory on the same filesystem device;
- repository-local temporary indices construct a standard stash whose first parent is
  the captured `HEAD`, second parent records the selected index state, and main
  tree records the selected worktree state; all non-selected paths match
  `HEAD`;
- `refs/stash` and a private recovery ref are published in one ref transaction,
  with an expected-old-value compare-and-swap and Git hooks disabled. Failure
  before publication leaves visible repository state untouched;
- phase journals are synchronously written below the absolute Git directory's
  `refhaven-recovery` folder before working-tree cleanup;
- each existing selected path is atomically renamed into that folder and
  verified, then the prepared `HEAD` file is linked into the now-empty path.
  Hard-link creation is no-clobber: a concurrent recreation receives priority
  and is never unlinked or overwritten;
- selected-index cleanup prepares a full index from the raw captured index,
  acquires the real `index.lock`, byte-compares the live index, synchronizes the
  replacement, and atomically renames it into place. Movement of `HEAD`, the index, or
  the working-tree path after stash publication produces a typed incomplete
  result instead of a forced restore.

Completed safety directories that contain an evacuated file are deliberately
retained. This protects writes through a file handle opened before the atomic
rename; automatic deletion would reintroduce a data-loss window. Incomplete
journals are retained, and the command reports incomplete cleanup immediately
with an action that reveals the directory. Recovery and deletion remain manual
after the user has closed possible writers and verified the stash, worktree,
and index. Successful finalization verifies `refs/stash` and removes the private
recovery ref atomically. If that verification loses a race, the journal retains
the ref for explicit cleanup with its expected stash SHA.

### Repository navigation

The Branches and Worktrees providers expose only local metadata from one
bounded `for-each-ref`, NUL-delimited `git worktree list --porcelain -z`, and
porcelain-v2 status reads. Local branches lazily load at most 20 recent commits
when expanded. Actions copy identifiers, create a saved comparison, or ask VS
Code to open an already enumerated worktree. Command inputs are re-enumerated
before use. Branch and worktree mutation is intentionally absent.

### Browser-link controller and domain

`domain/browserLinks.ts` is a VS Code-free trust boundary for exact origin parsing,
HTTP/SSH remote matching, project-path normalization, immutable target
validation, and final URL construction. With an empty setting, validated
HTTP(S) remotes retain their exact origin and SSH/scp-style remotes infer HTTPS
on the normalized hostname. With a non-empty setting, HTTP remotes match
scheme, hostname, and effective port exactly; SSH remotes can map only to
configured origins with the same hostname. Ambiguous mappings remain a user
choice.

`BrowserLinkController` revalidates the workspace repository, reads at most 32
remote names and eight URLs per remote through local transport-blocked Git,
resolves every ref target to a local SHA, and uses one URL-resolution path for
both `vscode.env.openExternal` and explicit clipboard-copy commands. The
Command Palette configuration flow validates and normalizes one exact origin
before updating workspace configuration; empty input restores local-remote
inference. The controller has no HTTP client, redirect handler, token storage,
background refresh, or cache. Quick picks display browser origin, project
path, and remote name, never the configured remote URL or credentials.

`ui/browserAutolinks.ts` renders commit-controlled text for trusted Markdown:
it escapes everything and turns boundary-checked `#123`/`!123` shorthand into
command links carrying only the repository root and reference text. The trust
list for autolinked surfaces contains the single reference-opening command,
and `openReferenceAt` revalidates both arguments before running the ordinary
origin-policy flow, so rendering can never contact a host by itself.

### BlameController

Listens to active-editor, selection, document, and configuration changes with a debounce, resolves the repository root per directory, and blames the cursor's line with `git blame --porcelain -L n,n`, feeding unsaved buffers up to 5 MiB through `--contents -`. Starting a newer update aborts the older Git process. It renders a dimmed end-of-line decoration and a status-bar item with a compact trusted-markdown tooltip whose fixed command links reuse existing copy/open commands. All Git-controlled Markdown is escaped before trust is enabled.

### LineHoverController and provider

The native `HoverProvider` makes blame details available across the complete
line range independently of the current-line decoration. The application
controller lazily resolves blame, full commit metadata, first-parent file
changes, and a bounded local patch. It caches only successful results by
document version and line, with 64-entry LRU eviction; repository watcher
events clear targets, Git usernames, and hover results.

The UI provider bridges VS Code cancellation to `AbortSignal`, renders escaped
trusted Markdown with an explicit command allowlist, limits patch presentation
to 24 lines/4,000 characters, and returns no hover after cancellation or a
safe local Git failure.

The hover also serves RefHaven's readonly revision documents (time-travel
blame). The controller accepts a revision document only after the content
provider verifies the URI's HMAC signature and the repository is still part of
the workspace, then blames at that pinned SHA instead of reading the buffer.
The "Before This Change" hover action opens the file at the blame `previous`
revision, so successive hovers walk a line's history backwards.

### FileAnnotationsController

Runs opt-in whole-file `git blame --line-porcelain` for gutter blame and the
five-bucket age heatmap; unsaved text is supplied over stdin. Changes mode
parses zero-context diff hunks against a locally resolved immutable base SHA
and deliberately waits for a dirty editor to be saved. Updates are debounced,
generation-checked, cancellable, capped at 5,000 lines, escaped before Markdown
rendering, and never persisted.

### RepositoryWatcher

Git metadata paths are resolved with `--absolute-git-dir` and
`--git-common-dir`. Deduplicated watchers cover `HEAD`, the index, refs, packed
refs, and reflogs in both locations, so linked worktrees and ordinary
repositories refresh correctly. Notifications are debounced; workspace-folder
changes re-discover repositories and rebuild the watchers.

## Activation and lifecycle

Activation performs only composition, command/provider registration, repository discovery setup, store read/validation, and immediate node restoration. It does not eagerly calculate every comparison. The target budget is less than 150 ms on the documented reference machine.

Disposables, cancellation sources, process handles, event subscriptions, and content providers are owned by the composition root or their parent service and are disposed on workspace/extension shutdown.

Runtime settings are read only through
`config/extensionConfiguration.ts`. Package-manifest defaults and bounds must
remain aligned with that module and are protected by manifest tests. Operational
errors are logged through `application/errorHandling.ts`; exception messages
remain user-facing only and are never copied into logs.

## Security and resource controls

- Enumerated refs originate from Git. Typed revisions are syntax-limited,
  resolved locally, and canonicalized to an immutable SHA before persistence.
- Git is never invoked through a shell or interpolated command string.
- Revision paths are canonicalized, proven repository-relative, signed in URI components, and revalidated before use.
- Output limits apply independently to stdout and stderr; timeouts are configurable from 1 to 300 seconds.
- `git show` content is neither logged nor preloaded.
- Git concurrency is bounded to four processes globally and two per repository; superseded work is cancelled.
- Logs redact repository identity and exclude credentials, environment, tokens, remote URLs, and file data.
- There is no telemetry, HTTP/API client, Git remote operation, or automatic
  fetch; Git transports and partial-clone lazy fetch are blocked at process
  level. Explicit GitLab commands may hand one fully validated, policy-matched
  URL to the external browser.

## Decisions requiring an ADR

Implementation stops for an ADR before changing ahead/behind semantics, the `branchChanges` or `tipToTip` endpoints, store format, repository identity, revision URI design, or cancellation strategy. ADR-001 establishes the initial clean-implementation decision; later material changes receive sequential ADRs.
