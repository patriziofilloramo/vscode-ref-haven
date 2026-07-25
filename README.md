# RefHaven

**RefHaven for Git. Your refs stay home.**

A private Visual Studio Code extension for persistent branch comparisons,
history, blame, and stash inspection. It uses an entirely native UI (no
webviews), has no telemetry, and enforces local-only Git execution.

## Features

### Branch Comparisons view (Source Control sidebar)

- Create comparisons such as `feature/oauth relative to main` and keep them
  across reloads; pin, swap direction, refresh, or close each one.
- **Ahead/Behind** sections list the commits unique to each side; expand a
  commit to see the files it changed and open each file's diff.
- **Files changed** shows the merge-base diff as a flat list or compacted
  folder tree with status badges, `+added −deleted` stats, and rich tooltips.
- Two diff modes per comparison (right-click → **Change Comparison Mode...**):
  **branch changes** (three-dot: only what the target added since the merge
  base) and **tip to tip** (two-dot: every difference between the branches).
  A fully merged target legitimately shows `0 files changed` in branch-changes
  mode — the view now explains why and suggests swapping or switching mode.
- Every file opens in VS Code's native readonly diff editor.

### Stashes view

- Lists all stashes per repository with message, `stash@{n}`, branch, and age.
- Expand a stash to browse and diff its files.
- **Stash This File...** is available from editor, Explorer, Source Control,
  and the file-actions quick menu. It stashes tracked staged and unstaged state
  for only that file, including partial staging, deletes, and renames, while
  preserving unrelated worktree and index changes.
- Stash files support Open at Stash Revision, Compare with HEAD, Compare with
  Working Tree, File History, and a cancellable search across the 50 most
  recent other stashes.
- Untracked files, conflicted files, repository metadata, and files with an
  active Git content filter are rejected. Apply, pop, and drop remain outside
  RefHaven.

### Line blame

- Dimmed inline blame at the end of the current line — `You, 2 hours ago ·
fix: prevent duplicates` — including in unsaved buffers.
- Hover anywhere on a file line for author/email, exact and relative dates,
  full SHA, original path/line, commit/file statistics, and a compact previous
  revision diff.
- Hover actions include commit details, previous/working-tree diffs, file and
  line history, open-at-revision, and copy actions; the status bar remains a
  compact entry point to the same workflows.
- Toggle via the `RefHaven: Toggle Inline Blame` command or settings.

### File annotations

- **Whole-file blame** adds a gutter marker and hover to every line, including
  unsaved buffers.
- **File heatmap** colors lines by the age of their last commit.
- **Changes relative to…** marks saved working-tree lines against any locally
  available reference. All modes are native, cancellable, and off by default.

### File and line history

- The **File History** Source Control view follows the active file across
  renames and opens each historical change in VS Code's native diff editor.
- History commits support copy SHA/message and open-at-revision actions.
- **Show Line History** traces the current selection locally with `git log -L`.

### References and commit search

- Comparisons support local/remote branches, tags, HEAD, typed revisions that
  resolve locally, and the live Working Tree.
- **Search Commits** finds local history by message, author, SHA, or changed
  content and opens a native **Commit Details** view with metadata and files.

### Branches and worktrees

- Read-only **Branches** view for local and remote-tracking refs, with copy and
  compare-with-current actions.
- Read-only **Worktrees** view with branch/detached/lock state, path copy, and
  open-in-new-window. RefHaven deliberately provides no repository-mutating
  branch or worktree commands.

### Everywhere

- The Explorer, editor, and Source Control file context menus share one native
  **RefHaven** submenu for stash, history, annotations, open-at-revision, and
  compare-with-revision actions.
- The editor title exposes a compact **RefHaven: Show File Actions** quick
  menu; the line-blame status entry exposes the same daily file workflows.
- Changed-file nodes support **Open File**, **Open File at Compared Revision**,
  **Show File History**, **Copy Path**, and **Copy Relative Path**; commits
  support **Copy SHA** / **Copy Commit Message**.
- **Open File at Revision...** opens the active file as it was on any branch.
- **Compare File with Revision...** opens a path-limited, native diff between
  a chosen local reference and the working-tree file.
- Views refresh automatically after commits, branch switches, fetches, and
  stash operations.

## Commands

Open the Command Palette and type `RefHaven:` to see all commands. The
most common entry points:

| Command                          | Description                                      |
| -------------------------------- | ------------------------------------------------ |
| `New Comparison`                 | Pick a repository, target, and base branch       |
| `Compare Current Branch With...` | Compare the checked-out branch against a base    |
| `Change Comparison Mode...`      | Switch between three-dot and two-dot diffs       |
| `Search Commits...`              | Search commits already available locally         |
| `Open File at Revision...`       | Open the active file at a chosen branch revision |
| `Compare File with Revision...`  | Diff the active file against a local reference   |
| `Stash This File...`             | Stash only the selected tracked file             |
| `Show File Actions`              | Open the context-sensitive native file menu      |
| `Toggle Inline Blame`            | Show or hide current-line blame                  |
| `Change File Annotations...`     | Blame, heatmap, changes, or off                  |

## Settings

| Setting                           | Default | Description                           |
| --------------------------------- | ------- | ------------------------------------- |
| `refhaven.inlineBlame.enabled`    | `true`  | Inline blame text on the current line |
| `refhaven.statusBarBlame.enabled` | `true`  | Blame entry in the status bar         |
| `refhaven.lineHover.enabled`      | `true`  | Rich local hover for any file line    |
| `refhaven.fileAnnotations.mode`   | `off`   | Whole-file blame or heatmap mode      |
| `refhaven.git.timeoutSeconds`     | `30`    | Per-command Git timeout (1–300 s)     |

## Development

Requires Node 20 and VS Code ≥ 1.105.

```bash
npm install
npm run compile        # type-check and build to dist/
npm run lint           # ESLint (strict, type-checked)
npm run format:check   # Prettier
npm run test:unit      # mocha unit tests (parsers, domain, manifest)
npm run test:extension # integration tests in a real VS Code instance
npm run package        # build refhaven-<version>.vsix
```

The VS Code task **RefHaven: Install Local VSIX** packages and installs the
extension into your running VS Code via the `code` CLI.

## Security

The installed extension has no runtime dependencies or networking code. Every
Git process blocks transports and lazy-fetch, disables prompts, tracing,
fsmonitor, external diff, and text conversion helpers, and runs without a
shell. Missing partial-clone objects fail locally instead of being fetched.
See `SECURITY.md` in the extension package for the complete guarantee and trust
boundaries.

Documentation lives in the `docs/` folder: `PRODUCT.md` (product definition),
`ARCHITECTURE.md` (layers and components), `GIT-SEMANTICS.md` (normative Git
ranges), `DEPENDENCIES.md` (supply-chain policy), `TEST-MATRIX.md`, and
`ROADMAP.md` (delivered and planned feature batches).
