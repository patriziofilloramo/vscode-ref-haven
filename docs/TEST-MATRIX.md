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

The security-hardening suite additionally covers repository-relative path containment, cross-platform backslash traversal, complete persisted-schema validation, duplicate IDs, trusted-Markdown escaping, scheduler concurrency and queued cancellation, bounded-cache eviction and rejection behaviour, signed revision-URI tampering, in-flight comparison cancellation, nested repository identities, real linked-worktree metadata discovery, and the exact local-only Git environment/config policy. Release gates also require zero production dependencies, an audit-clean lockfile, and inspection of the packaged VSIX contents.

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
rejection, heatmap age buckets, zero-context diff hunks, unsaved-buffer blame,
and real changed-line range calculation.
Interaction-surface coverage includes exact command and submenu contributions,
Extension Host command registration, canonical URI/tree-node file resolution,
and a real path-limited working-tree comparison that excludes changes in other
files.
Rich-hover coverage includes extended blame-porcelain metadata, malicious
Markdown/backtick fixtures, command allowlists, bounded patch rendering, real
local patch loading, and `vscode.executeHoverProvider` over a complete line.
Single-file-stash coverage uses real repositories for modified, staged,
partially staged, deleted, renamed, Unicode, whitespace, bracket/pathspec,
long-path, linked-worktree, clean, untracked, metadata, content-filter, and
hook scenarios. Tests prove unrelated index/worktree preservation, standard
stash-list parsing, and `git stash apply --index` compatibility.
Approved-GitLab coverage includes exact-origin normalization, scheme/port/path
rejection, credential stripping, HTTP-versus-SSH matching, unsafe encoded
project paths, immutable commit/tree/compare/file URLs, line ranges,
issue/MR validation, final-origin enforcement, bounded local remote reading,
manifest allowlist defaults, command registration, and hover command
allowlists. No test or activation path opens a browser or contacts a host.
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
- no-common-ancestor classification.

### Persistence and state

- schema-v1 serialization/validation and migration dispatch;
- UUID independence for duplicate ref pairs;
- create/update/delete without persisting runtime results;
- pinned-first stable ordering and explicit reorder;
- preservation of missing repository/ref comparisons;
- restore of five comparisons with IDs, order, modes, refs, and pins unchanged;
- generation race: older completion cannot replace newer state;
- cancellation on refresh replacement, edit, close, and disposal;
- two-per-repository and four-global scheduler limits;
- SHA-based cache keys including mode, operation, and pagination.

### Revision documents and UI mapping

- validated URI encode/decode with Unicode and unusual path characters;
- rejection of malformed URI, unknown repository, symbolic ref, and invalid SHA;
- added/deleted empty-side selection;
- rename/copy old/new side selection;
- binary changes do not invoke text diff;
- safe comparison labels, descriptions, tooltips, error nodes, modes, and commit section labels;
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

## Extension Host tests

- extension activation stays independent of comparison calculation;
- all declared commands are registered;
- Explorer/editor RefHaven file actions and the editor-title quick menu are
  contributed with file-only context clauses;
- Source Control resource objects resolve through the same canonical file
  boundary, and the RefHaven submenu contributes Stash This File;
- GitLab commands register without enumerating remotes or opening a browser;
  remote URLs are read only in an explicit command path;
- `refhaven.comparisons` is contributed to Source Control;
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
11. From Source Control, stash a partially staged file while unrelated staged
    and unstaged files are present; verify only the selected path becomes
    clean, then inspect and apply the stash with `--index`.
12. With no approved GitLab origin, invoke an Open on GitLab action and verify
    that RefHaven offers Settings without opening a browser. Add the exact
    internal origin, verify project/commit/comparison/file-line/issue/MR links,
    then configure a non-matching port and verify fail-closed behavior.
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
