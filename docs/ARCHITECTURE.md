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
  domain/                  // VS Code-free types and pure logic
    blame.ts
    commitDetails.ts
    comparison.ts
    comparisonResult.ts
    fileDiffScope.ts
    stash.ts
    validation.ts
  application/             // orchestration; owns runtime state
    BlameController.ts
    CommitDetailsController.ts
    ComparisonController.ts
    ComparisonEngine.ts
    ComparisonStore.ts
    FileAnnotationsController.ts
    FileHistoryController.ts
    Logger.ts
    RepositoryNavigationController.ts
    RepositoryWatcher.ts
    StashController.ts
  infrastructure/
    git/                   // typed git CLI operations and tested parsers
      GitCli.ts
      blamePorcelain.ts
      branchRefs.ts
      commitLog.ts
      commitDetails.ts
      diffHunks.ts
      fileHistory.ts
      nameStatus.ts
      numstat.ts
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
      StashTreeProvider.ts
      WorktreesTreeProvider.ts
      changeNodes.ts       // file/folder/message nodes shared by all trees
      fileTree.ts
test/
  unit/
  extension/
```

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

`GitCli.ts` launches `git` with `execFile`, argument arrays, and no shell. Every operation runs through `GitScheduler`, which enforces four global and two per-repository processes. The adapter owns cancellation, configurable timeouts, encoding, 5 MiB stdout/stderr limits, and safe error mapping. It returns buffers only for immutable file content and decoded output for typed parsers.

`gitProcessPolicy.ts` is the single local-only process boundary. It blocks every Git transport and lazy object fetch, disables prompts/pagers/tracing/fsmonitor/optional locks/replace objects, removes inherited repository and command-config redirection, and prevents external diff/textconv execution. The policy is applied to string, buffer, and stdin invocations and is covered by exact regression tests.

### GitClient

Provides typed operations for repository probing, branch listing, ref resolution, merge base, ahead/behind, commit pages, changed files, numstat, and on-demand object content. It owns Git command construction and parser selection while preserving the normative ranges in [GIT-SEMANTICS.md](GIT-SEMANTICS.md).

### Repository discovery

Uses the exported API of VS Code's built-in Git extension only when that extension is already active, discovering known repositories including nested repositories without activating a component that may be configured for autofetch. Repository identity combines workspace folder URI and repository path relative to it; path identity is case-sensitive except on Windows, and worktrees remain distinct even when they share a common Git directory.

If `vscode.git` is unavailable, discovery probes each workspace folder with `git rev-parse --show-toplevel` and supports at least one repository per folder. The CLI remains the authority for comparison calculations.

### ComparisonStore

Reads and atomically writes `refhaven.comparisons.v1` in `workspaceState`. It strictly validates the complete schema, rejects malformed repository paths and branch refs, removes duplicate logical identities and IDs, and implements create, update, delete, and pin operations. It sorts pinned comparisons first while preserving explicit order within pinned and unpinned groups.

### ComparisonEngine

Accepts a comparison specification and cancellation token, resolves both refs, computes counts and commit pages, selects the diff endpoints by mode, and combines name-status and numstat results. Working-tree comparisons keep the resolved base immutable while using the live file as the right diff side. It returns a typed result and does not call VS Code UI APIs.

### CommitDetailsController and provider

Commit search dispatches typed, bounded local Git queries by message, author,
SHA, or changed content. Selecting a result loads full NUL-delimited metadata
and changed files into a native tree; neither search results nor commit details
are persisted.

### ComparisonController

Coordinates store, engine, commands, and view updates. Creating a comparison persists it before calculation. Swapping persists the new symbolic configuration, cancels prior work, increments its generation, and starts a new calculation when the node is expanded.

Only a result whose captured generation equals the state's current generation may be applied. Closing a comparison cancels its work before removing it. Errors update runtime state but do not delete persisted configuration.

### Refresh scheduler and cache

The scheduler enforces two concurrent Git processes per repository and four globally. Queued work is abortable, and `AbortSignal` is passed to running child processes. Repository events invalidate active results; expansion then resolves refs again. There is no background polling.

Comparison results are cached by active comparison ID and protected by a generation counter. Commit-file results are keyed by repository and commit SHA. Refresh, replacement, and close abort and remove the affected in-flight state before a stale result can be installed.

### Tree provider

The `TreeDataProvider` maps controller state to repository, comparison, commit-section, commit, file-section, file, error, and load-more nodes. It performs no Git operations. Repository grouping appears only for multiple repositories. Section labels preserve direction and always expose the file comparison mode.

The controller creates restored nodes synchronously in `notComputed`. Expansion or visibility requests schedule computation through the controller. `onDidChangeTreeData` updates only affected nodes where possible.

The provider implements `getParent` for comparison roots, their sections, and
commit nodes. This is part of the reveal contract: VS Code cannot reliably
select or expand a programmatically revealed node unless it can reconstruct
that node's path to the tree root.

### Revision document provider

The readonly `refhaven:` provider parses validated opaque URIs and obtains content on demand with `git show <sha>:<path>`. Every URI is authenticated with a session-scoped HMAC before parsing. Paths must be canonical forward-slash Git paths and cannot be absolute, traverse, or change meaning on Windows. Resolved text uses a 64-entry/16 MiB LRU cache; rejected loads are not cached. An explicit empty-document URI supplies the missing side of added/deleted changes.

Renames use the old path at the from-SHA and the new path at the to-SHA. Binary files do not pass through the text provider; UI actions offer opening available revisions instead of a misleading text diff.

### Shared change nodes and FileDiffScope

`domain/fileDiffScope.ts` defines the pair of revisions a set of file changes was computed between. `ui/tree/changeNodes.ts` renders `FileChange` lists as file/folder/message nodes (flat or compacted tree) with a `FileDiffScope` attached to every file node. Comparisons, expanded commits, and stashes all produce these nodes, so one `openFileDiff` command serves every tree.

### StashController and StashTreeProvider

The read-only stash view lists `git stash list` entries (parsed from a NUL-safe `--format`) per repository and expands each stash into its tracked file changes (first parent → stash commit). Mutating stash actions are excluded because Git may invoke repository-configured filters or merge drivers during them; those processes cannot be sandboxed portably.

### Repository navigation

The Branches and Worktrees providers expose only local metadata from
`for-each-ref` and NUL-delimited `git worktree list --porcelain -z`. Actions
copy identifiers, create a saved comparison, or ask VS Code to open an already
enumerated worktree. Command inputs are re-enumerated before use. Branch and
worktree mutation is intentionally absent.

### BlameController

Listens to active-editor, selection, document, and configuration changes with a debounce, resolves the repository root per directory, and blames the cursor's line with `git blame --porcelain -L n,n`, feeding unsaved buffers up to 5 MiB through `--contents -`. Starting a newer update aborts the older Git process. It renders a dimmed end-of-line decoration and a status-bar item; both carry a trusted-markdown hover whose fixed command links reuse existing copy/open commands. All Git-controlled Markdown is escaped before trust is enabled.

### FileAnnotationsController

Runs opt-in whole-file `git blame --line-porcelain` for gutter blame and the
five-bucket age heatmap; unsaved text is supplied over stdin. Changes mode
parses zero-context diff hunks against a locally resolved immutable base SHA
and deliberately waits for a dirty editor to be saved. Updates are debounced,
generation-checked, cancellable, capped at 5,000 lines, escaped before Markdown
rendering, and never persisted.

### RepositoryWatcher

Git metadata paths are resolved with `--absolute-git-dir` and `--git-common-dir`. Deduplicated watchers cover `HEAD`, refs, packed refs, and reflogs in both locations, so linked worktrees and ordinary repositories refresh correctly. Workspace-folder changes re-discover repositories and rebuild the watchers.

## Activation and lifecycle

Activation performs only composition, command/provider registration, repository discovery setup, store read/validation, and immediate node restoration. It does not eagerly calculate every comparison. The target budget is less than 150 ms on the documented reference machine.

Disposables, cancellation sources, process handles, event subscriptions, and content providers are owned by the composition root or their parent service and are disposed on workspace/extension shutdown.

## Security and resource controls

- Enumerated refs originate from Git. Typed revisions are syntax-limited,
  resolved locally, and canonicalized to an immutable SHA before persistence.
- Git is never invoked through a shell or interpolated command string.
- Revision paths are canonicalized, proven repository-relative, signed in URI components, and revalidated before use.
- Output limits apply independently to stdout and stderr; timeouts are configurable from 1 to 300 seconds.
- `git show` content is neither logged nor preloaded.
- Git concurrency is bounded to four processes globally and two per repository; superseded work is cancelled.
- Logs redact repository identity and exclude credentials, environment, tokens, remote URLs, and file data.
- There is no telemetry, networking API, remote operation, or automatic fetch; Git transports and partial-clone lazy fetch are blocked at process level.

## Decisions requiring an ADR

Implementation stops for an ADR before changing ahead/behind semantics, the `branchChanges` or `tipToTip` endpoints, store format, repository identity, revision URI design, or cancellation strategy. ADR-001 establishes the initial clean-implementation decision; later material changes receive sequential ADRs.
