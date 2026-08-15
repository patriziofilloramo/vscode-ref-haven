# Test matrix

## Quality gates

No implementation milestone is complete until its acceptance tests are written first and all relevant checks are green:

```text
npm test
npm run test:extension
npm run lint
npm run compile
npm run format:check
npm run package
```

These scripts preserve separate unit, real-Git/Extension Host, compile, lint, format, and VSIX packaging gates. Failures block the milestone commit.

The security-hardening suite additionally covers repository-relative path containment, host-specific Windows path restrictions, valid POSIX names, complete persisted-schema validation, duplicate IDs, trusted-Markdown escaping, scheduler concurrency and queued cancellation, bounded-cache eviction and rejection behaviour, signed revision-URI tampering, in-flight comparison cancellation, nested repository identities, real linked-worktree metadata discovery, and the exact local-only Git environment/config policy. Release gates also require zero production dependencies, an audit-clean lockfile, and inspection of the packaged VSIX contents.

## CI operating-system matrix

| Suite                  |      Windows       |  Linux   |       macOS        |
| ---------------------- | :----------------: | :------: | :----------------: |
| Unit tests             |      Required      | Required |      Required      |
| Git integration        |      Required      | Required | Optional initially |
| Extension Host         | Optional initially | Required | Optional initially |
| Build and VSIX package |      Required      | Required | Optional initially |

Windows is mandatory for process spawning, path, encoding, and filesystem edge cases. Linux is the initial Extension Host environment. macOS unit coverage guards platform-neutral domain and parser behaviour. A public beta should expand integration and packaging coverage where runner stability permits.

## Milestone acceptance coverage

History coverage includes delimiter-safe `--follow` parser tests, rename-aware
File History integration, and real `git log -L` execution in the Extension Host.
Reference/search coverage includes tag parsing, strict typed-ref validation,
real Working Tree comparison, local commit search, and full commit-detail
loading in the Extension Host.
Repository-navigation coverage includes strict NUL-delimited worktree parser
fixtures and real worktree enumeration in the Extension Host.
Annotation coverage includes repeated line-porcelain parsing, duplicate-line
rejection, all five heatmap age buckets plus the distinct uncommitted state,
stable location normalization with safe defaults, the complete public theme
color contract, zero-context diff hunks, unsaved-buffer blame, and real changed-
line range calculation. The direct toggle's persisted-state transition has
unit coverage, while the Extension Host verifies both heatmap commands are
registered.
Interaction-surface coverage includes exact command and submenu contributions,
Extension Host command registration, canonical URI/tree-node file resolution,
and a real path-limited working-tree comparison that excludes changes in other
files.
Rich-hover coverage includes extended blame-porcelain metadata, malicious
Markdown/backtick fixtures, command allowlists, bounded patch rendering, real
local patch loading, and `vscode.executeHoverProvider` over a complete line.
Stash coverage verifies delimiter-safe inspection of existing stash commits
and the restored single-file mutation. Manifest and Extension Host tests prove
that **Stash This File...** appears once inside the unified RefHaven submenu on
each applicable surface; command routing accepts both Source Control resource
state and Git API change objects, opens the message prompt without touching a
dirty buffer, and saves and stashes that buffer only after confirmation.
Browser-link coverage includes zero-config HTTP-origin preservation,
SSH-to-HTTPS inference, invalid/local remote rejection, `origin` preference, exact-origin
normalization, strict allowlist scheme/port/path enforcement, credential
stripping, unsafe encoded project paths, immutable commit/tree/compare/file
URLs, line ranges, issue/MR validation, final-origin enforcement, bounded local
remote reading, manifest setting semantics, command registration, and hover
command allowlists. No test or activation path opens a browser or contacts a
host.
Comparison-review coverage includes order-independent revision fingerprints,
endpoint/file-state invalidation, conservative Working Tree invalidation,
strict bounded record validation, stale-path rejection, closed-comparison
cleanup, per-record byte ceilings, filter/sort behavior, manifest/command
registration, and native tree progress/review decorations. Review tests do not
read file content or mutate a repository.
Native-view-enrichment coverage includes delimiter-safe branch tracking
metadata, gone-upstream handling, porcelain-v2 worktree state including rename
continuations, real branch tip/history/status reads, exact command/manifest
registration, and local-only lazy loading. Filters are in-memory presentation
state and introduce no persistence or network path.
Maintenance-hardening coverage includes trusted Markdown command arguments
containing unbalanced parentheses, unchanged blame-origin suppression,
fallback inline hover behavior, separate selected-index/worktree stash
snapshots, and rejection of review writes carrying a stale revision key.
Concurrent review-write tests force asynchronous workspace-state updates and
verify that both file marks survive.
Comparison-store tests apply the same delayed-write fixture to concurrent
replace/add operations, order collisions, and recovery after a rejected write.
Parser tests cover control characters in metadata, strict decimal timestamp
bounds, and exact 40/64-character object IDs without duplicating the domain
validator.

| Milestone        | Tests written before implementation                                                    | Required completion evidence                                          |
| ---------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0: decision/docs | documentation links, terminology and protected-decision review                         | five foundational documents present and internally consistent         |
| 1: skeleton      | activation, command registration, empty Tree View, configuration and logging contracts | unit/Extension Host tests, lint, strict compile, package              |
| 2: Git core      | parser fixtures and real-repository scenarios 1–13 below                               | unit and Git integration green before results UI work                 |
| 3: persistence   | schema validation, migration, CRUD, pin/order, invalid rejection, five-item restore    | unit tests plus Extension Host workspaceState restore                 |
| 4: Tree View     | single/multi-repository layout, state nodes, command routing, keyboard flows           | unit view-model and Extension Host command/view tests                 |
| 5: native diff   | URI round-trip, immutable SHA use, add/delete/rename/copy/binary sides                 | provider unit tests and `vscode.diff` invocation tests                |
| 6: refresh       | generation race, cancellation, queue limits, cache keys, focus/visibility staleness    | deterministic scheduler/controller tests and integration cancellation |
| 7: hardening     | unusual paths, large output, shallow/missing objects, worktrees, multi-root, timeout   | cross-platform integration results and measured limits                |
| 8: packaging     | clean install, README workflows, privacy/licence notices, manual scenarios             | installable VSIX, test report, limitations, screenshot                |

## Unit tests

### Parsers and Git semantics

- ahead/behind output with zero, linear, divergent, whitespace, malformed, negative, overflow, empty, and truncated values;
- target-only and base-only range construction;
- empty name-status output;
- added, modified, deleted, renamed, copied, type-changed, and unmerged statuses;
- rename/copy similarity scores;
- NUL-delimited paths containing Unicode, spaces, tabs, and newlines;
- malformed/truncated NUL records and unknown statuses;
- numstat text values, rename pairs, binary `-/-`, missing data, and aggregation;
- branchChanges and tipToTip endpoint selection;
- no-common-ancestor classification;
- Git binary resolution: configured absolute path wins, relative/missing
  configured paths fall through to `PATH`, empty and relative `PATH` entries
  are never resolved, Windows executable extensions include `git.exe`, and an
  absent `PATH` or no absolute match fails closed.

### Data-egress guard

- the full source tree imports no network or code-loading module
  (`http`, `https`, `net`, `tls`, `dns`, `worker_threads`, …);
- no source file uses a network or code-execution primitive (`fetch`,
  `WebSocket`, `XMLHttpRequest`, `sendBeacon`, `eval`, dynamic `import`) or a
  telemetry API;
- process execution appears only in `GitProcess.ts` and the browser handoff
  only in `BrowserLinkController.ts`; a match elsewhere fails the build;
- the manifest declares zero runtime and extension dependencies.

### Persistence and state

- schema-v1 serialization/validation and migration dispatch;
- UUID independence for duplicate ref pairs;
- create/update/delete without persisting runtime results;
- pinned-first stable ordering and explicit reorder;
- preservation of missing repository/ref comparisons;
- restore of five comparisons with IDs, order, modes, refs, and pins unchanged;
- generation race: older completion cannot replace newer state;
- cancellation on refresh replacement, edit, close, and disposal;
- batched Working Tree invalidation emits one refresh for multiple results;
- commit-detail loads discard stale selections, preserve captured repository
  context, and propagate only current non-cancellation failures;
- two-per-repository and four-global scheduler limits;
- SHA-based cache keys including mode, operation, and pagination.

### Revision documents and UI mapping

- validated URI encode/decode with Unicode and unusual path characters;
- rejection of malformed URI, unknown repository, symbolic ref, and invalid SHA;
- added/deleted empty-side selection;
- rename/copy old/new side selection;
- binary changes do not invoke text diff;
- safe comparison labels, descriptions, tooltips, error nodes, modes, and commit section labels;
- custom comparison labels set, prefer, and clear cleanly against the
  ref-derived default; persisted labels are rejected when empty, untrimmed,
  oversized, or contain non-printable characters;
- reference autolinks linkify only boundary-checked `#`/`!` references, keep all
  surrounding text escaped, reject ASCII and Unicode word-adjacent candidates,
  percent-encode parentheses, and declare exactly one trusted command; hover
  summaries and the time-travel action render with validated arguments;
- repository grouping only when more than one repository exists.

## Git integration scenarios

Every test creates an isolated temporary repository, configures deterministic author data and timestamps where assertions require them, and cleans up after itself.

1. **Linear ahead:** `main: A`, `feature: A-B-C`; expect ahead 2, behind 0.
2. **Linear behind:** `main: A-B-C`, `feature: A`; expect ahead 0, behind 2.
3. **Diverged:** two commits on each side after A; expect ahead 2, behind 2.
4. **Rename:** verify status, score where emitted, old/new paths, and distinct diff sides.
5. **Added/deleted:** verify empty-document sides and revision availability.
6. **Binary:** verify binary numstat and absence of text-diff invocation.
7. **Deleted branch:** saved specification survives and reports a recoverable missing-ref error.
8. **Remote-tracking ref:** compare `refs/heads/feature` with `refs/remotes/origin/main`.
9. **No common ancestor:** independent roots; branchChanges errors and tip-to-tip remains available.
10. **Shallow clone:** missing history/object receives a comprehensible typed error.
11. **Detached HEAD:** repository discovery succeeds; current-branch flow explains why it cannot continue.
12. **Worktrees:** worktrees sharing a common Git directory keep distinct repository identities.
13. **Multi-root:** persisted repository paths resolve to the correct workspace folders after restore.
14. **Multiple persistence:** create at least five comparisons, restart the Extension Host, and verify count, order, refs, modes, and pins.

Additional hardening fixtures cover filenames with spaces, tabs, newlines and non-ASCII characters; type changes; applicable merge-conflict states; thousands of changed files; timeout; cancellation; stdout/stderr limits; missing Git; repository deletion; and forced ref movement during overlapping refreshes.

### Single-file stash transaction

Required real-repository coverage preserves and compares the complete index
and worktree around each operation. It covers:

- selected unstaged, staged, and partially staged content, with
  a standard two-parent result and `git stash apply --index` reconstructing the
  separate states;
- staged additions, deletions, and detected renames;
- unrelated staged and unstaged changes remaining byte-for-byte and
  entry-for-entry unchanged;
- Unicode, bracket, nested, and long literal paths plus linked worktrees;
- hooks that would fail or modify state remaining disabled;
- fail-closed rejection of clean/untracked files, conflicts, active filters,
  sparse/skip-worktree or special index entries, symlinks/gitlinks, content
  over 64 MiB, and unsupported filesystem boundaries;
- compare-and-swap failure when another process updates `refs/stash`, with no
  visible selected-file or index cleanup;
- deterministic barriers before evacuation, after evacuation, and before
  index cleanup. A concurrent file recreation is never overwritten, an
  already-published stash remains identified, newer index state survives, and
  the recovery journal/safety copy remains inspectable;
- more than 256 completed safety-copy directories remain inspectable without
  consuming the bounded allowance for genuinely unfinished recovery records;
- a raw full-index compare-and-swap for both changed and initially clean
  selected entries, plus retained private recovery refs when the stash list
  moves after publication;
- successful cleanup retaining an evacuated file and a completion journal,
  so a writer that kept the pre-rename file handle cannot lose later bytes;
- incomplete cleanup retaining its journal without automatically restoring or
  deleting repository data, while the command warning offers the recovery
  directory for inspection.

## Extension Host tests

- extension activation stays independent of comparison calculation;
- an isolated workspace opened below its Git root discovers the canonical
  containing repository and provides rich line hover using the full
  repository-relative path, covering local and Remote SSH workspace layouts;
- all declared commands are registered;
- Explorer/editor RefHaven file actions and the editor-title quick menu are
  contributed with file-only context clauses;
- Source Control resource and Git API change objects resolve through the same
  canonical file boundary; cancelling the message leaves an unsaved selected
  editor untouched, while confirmation saves it and creates the expected
  single-file stash through the public command;
- browser-link commands register without enumerating remotes or opening a
  browser;
  remote URLs are read only in an explicit command path;
- restricted-origin input accepts only exact HTTP(S) origins, empty input
  restores zero-config inference, and copied links pass through the same
  immutable-ref and final-origin validation as browser-open actions;
- comparison file nodes expose a complete parent chain so native reveal can
  focus the matching item in both list and compacted-tree layouts;
- blame at a pinned revision returns that revision's commit and its `previous`
  metadata, and rejects buffer contents combined with a revision or a
  non-SHA revision argument;
- comparison and single-file patches are produced locally, respect literal
  path limits, cover root commits, include working-tree changes when one
  endpoint is live, preserve non-UTF-8 bytes verbatim, export beyond the 5 MiB
  text ceiling within the raised patch ceiling, and reject missing or
  symbolic revisions;
- merge forecasts report clean ancestors, name genuinely conflicting paths,
  leave `git status --porcelain` empty, and reject symbolic revisions;
- revision-document identity is exposed only for URIs the provider signed
  itself: tampered, foreign-provider, empty-document, and re-schemed URIs
  all return null;
- Branch Comparisons, Stashes, Inspector, and Repository are contributed to
  Source Control, with the composite views preserving their child providers;
- New Comparison works by keyboard through repository/base/target/mode picks;
- Compare Current Branch With uses current branch as target and defaults to branchChanges;
- restored nodes appear immediately as not computed;
- expanding/refreshing computes and updates the correct node;
- reviewed progress and file decorations update without recalculating Git;
- review filtering affects only saved-comparison file nodes;
- file click invokes `vscode.diff` with immutable revision or empty URIs;
- close, edit, swap, mode change, pin, reorder, refresh-all, and bulk-close commands update state/store;
- missing refs remain visible with recovery actions;
- light and dark themes retain readable native presentation.

## Manual release scenarios

Before delivering `refhaven-x.y.z.vsix`:

1. Install the VSIX into a clean stable VS Code profile.
2. Open a workspace containing at least two repositories.
3. Create at least three comparisons across repositories, including one remote-tracking ref and both modes.
4. Pin and reorder comparisons, reload the window, and confirm exact restoration before calculation.
5. Commit from a terminal, regain focus, observe stale state, and refresh.
6. Delete a compared branch and verify recoverable error without data loss.
7. Open modified, added, deleted, and renamed diffs; verify immutable SHA sides.
8. Verify binary handling does not show a text diff.
9. Exercise keyboard-only creation and actions in light and dark themes.
10. From Explorer, editor, editor title, status-bar blame, and a changed-file
    node, verify the same file history/revision actions target the intended
    repository and path.
11. Run **Stash This File...** from the Command Palette and the unified RefHaven
    file-actions submenu in Source Control, Explorer, and an editor on staged,
    unstaged, and partially staged tracked files. Verify unrelated changes
    remain intact, `git stash apply --index` reconstructs the selected states,
    and the retained safety directory opens from the completion message. Close all
    writers and inspect the stash, worktree, index, and completion journal
    before manually removing that directory. Also confirm an unsaved selected
    editor is saved only after accepting the stash message, while every
    documented unsupported case fails without mutation.
12. With an empty approved-origin list, verify HTTP and SSH remotes immediately
    open the expected project/commit/comparison/file-line/issue/MR targets.
    Add the exact internal origin and verify strict allowlist behavior, then
    configure a non-matching port and verify fail-closed behavior. For an SSH
    remote whose browser uses a custom port, configure that explicit origin and
    verify it replaces the default HTTPS inference.
13. Capture the required screenshot with at least three persistent comparisons.
14. Mark several comparison files reviewed, reload VS Code, and verify progress
    survives while the refs are unchanged. Move the target ref and verify the
    old review is ignored; refresh a Working Tree comparison and verify its
    review resets. Exercise Quick Open, filters, all three sorts, and
    Next/Previous Unreviewed using only the keyboard.
15. Filter Stashes and File History, expand a stash and local branch, navigate
    commit parents and adjacent file revisions, and confirm Worktrees reports
    clean/dirty state without changing repository state or contacting a remote.

The release report records extension/version, commit SHA, VS Code and Git versions, operating systems, CI links, manual outcomes, known limitations, benchmark hardware/dataset, activation time, large-comparison responsiveness, and the final VSIX checksum.
