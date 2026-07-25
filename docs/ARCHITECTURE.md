# Architecture

## Architectural goals

Branch Compare uses a clean, layered implementation with a native VS Code Tree View. Git mechanics, comparison semantics, persistence, orchestration, and presentation remain independently testable. Tree nodes never execute Git directly, and the Git process layer has no knowledge of comparisons or VS Code UI.

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

## Proposed source layout

```text
src/
  extension.ts
  domain/
    comparison.ts
    comparisonResult.ts
    fileChange.ts
    repository.ts
    errors.ts
  application/
    ComparisonController.ts
    ComparisonEngine.ts
    ComparisonRefreshScheduler.ts
    ComparisonCache.ts
  infrastructure/
    git/
      GitProcess.ts
      GitClient.ts
      GitRepositoryRegistry.ts
      GitCommandError.ts
      parsers/
        parseAheadBehind.ts
        parseNameStatusZ.ts
        parseNumStatZ.ts
        parseLog.ts
    persistence/
      ComparisonStore.ts
      ComparisonMigrations.ts
  ui/
    tree/
      ComparisonTreeProvider.ts
      nodes/
    documents/
      GitRevisionContentProvider.ts
      revisionUri.ts
    commands/
    quickpick/
  configuration/
    configuration.ts
test/
  unit/
  integration/
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

Errors use stable codes: `gitNotFound`, `repositoryNotFound`, `baseRefMissing`, `targetRefMissing`, `noCommonAncestor`, `objectMissing`, `shallowRepository`, `commandTimedOut`, `commandCancelled`, `outputTooLarge`, `unsupportedBinary`, and `unknown`. Each error has a safe user message, recoverability, suggested actions, and optional redacted technical details. Raw stderr is never the primary UI message.

## Components

### GitProcess

Launches `git` with `spawn` or `execFile`, argument arrays, and no shell. It owns cancellation, timeout, encoding, bounded stdout/stderr capture, exit status, and redacted operational logging. It returns raw buffers or explicitly decoded output as required by the caller. It knows nothing about branch comparisons or Tree View nodes.

### GitClient

Provides typed operations for repository probing, branch listing, ref resolution, merge base, ahead/behind, commit pages, changed files, numstat, and on-demand object content. It owns Git command construction and parser selection while preserving the normative ranges in [GIT-SEMANTICS.md](GIT-SEMANTICS.md).

### GitRepositoryRegistry

Uses the exported API of VS Code's built-in Git extension to discover known repositories, current branches, and broad repository changes. Repository identity combines workspace folder URI and repository path relative to it; worktrees remain distinct even when they share a common Git directory.

If `vscode.git` is unavailable, the registry probes each workspace folder with `git rev-parse --show-toplevel`, supports at least one repository per folder, and exposes reduced auto-refresh capability through a warning. The CLI remains the authority for comparison calculations.

### ComparisonStore

Reads and atomically writes `branchCompare.comparisons.v1` in `workspaceState`. It validates schema versions, delegates migration, and implements create, update, delete, pin, and reorder operations. It sorts pinned comparisons first while preserving explicit order within pinned and unpinned groups. Invalid repository/ref configurations are retained.

### ComparisonEngine

Accepts a comparison specification and cancellation token, resolves both refs, computes counts and commit pages, selects the diff endpoints by mode, and combines name-status and numstat results. It returns a typed result and does not call VS Code UI APIs.

### ComparisonController

Owns runtime states and coordinates store, engine, scheduler, cache, commands, and view updates. Creating a comparison persists it before calculation. Editing or swapping persists the new symbolic configuration, cancels prior work, increments its generation, and starts a new calculation when appropriate.

Only a result whose captured generation equals the state's current generation may be applied. Closing a comparison cancels its work before removing it. Errors update runtime state but do not delete persisted configuration.

### Refresh scheduler and cache

The scheduler enforces two concurrent Git processes per repository and four globally, supports cancellation and progress, and prioritises user-visible work. Repository events mark affected state stale. Focus and view-visibility events re-resolve the refs of visible comparisons. No background polling runs while VS Code is unfocused.

Cache entries are immutable and keyed by repository identity, resolved base SHA, resolved target SHA, comparison mode, operation, and pagination. Symbolic names are not final cache keys.

### Tree provider

The `TreeDataProvider` maps controller state to repository, comparison, commit-section, commit, file-section, file, error, and load-more nodes. It performs no Git operations. Repository grouping appears only for multiple repositories. Section labels preserve direction and always expose the file comparison mode.

The controller creates restored nodes synchronously in `notComputed`. Expansion or visibility requests schedule computation through the controller. `onDidChangeTreeData` updates only affected nodes where possible.

### Revision document provider

The readonly `branch-compare:` provider parses validated opaque URIs and obtains content on demand with `git show <sha>:<path>`. URIs carry a repository identifier, immutable SHA, and encoded path, never a symbolic ref or credential. An explicit empty-document URI supplies the missing side of added/deleted changes.

Renames use the old path at the from-SHA and the new path at the to-SHA. Binary files do not pass through the text provider; UI actions offer opening available revisions instead of a misleading text diff.

## Activation and lifecycle

Activation performs only composition, command/provider registration, repository discovery setup, store read/validation, and immediate node restoration. It does not eagerly calculate every comparison. The target budget is less than 150 ms on the documented reference machine.

Disposables, cancellation sources, process handles, event subscriptions, and content providers are owned by the composition root or their parent service and are disposed on workspace/extension shutdown.

## Security and resource controls

- Refs originate from Git enumeration, not arbitrary user text.
- Git is never invoked through a shell or interpolated command string.
- Revision paths are passed as arguments/object specifiers and URI components are strictly encoded and validated.
- Output limits apply independently to stdout and stderr; timeouts are configurable.
- `git show` content is neither logged nor preloaded.
- The view caps initial display at 5,000 files and reports truncation.
- Logs redact repository identity and exclude credentials, environment, tokens, remote URLs, and file data.
- There is no telemetry, network request, or automatic fetch.

## Decisions requiring an ADR

Implementation stops for an ADR before changing ahead/behind semantics, the `branchChanges` or `tipToTip` endpoints, store format, repository identity, revision URI design, or cancellation strategy. ADR-001 establishes the initial clean-implementation decision; later material changes receive sequential ADRs.
