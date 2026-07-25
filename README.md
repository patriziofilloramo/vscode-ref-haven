# Branch Compare

A Visual Studio Code extension for persistent, directional Git branch
comparisons — growing toward a GitLens-style feature set with an entirely
native UI (no webviews) and no telemetry.

## Features

### Branch Comparisons view (Source Control sidebar)

- Create comparisons such as `feature/oauth relative to main` and keep them
  across reloads; pin, swap direction, refresh, or close each one.
- **Ahead/Behind** sections list the commits unique to each side; expand a
  commit to see the files it changed and open each file's diff.
- **Files changed** shows the merge-base diff as a flat list or compacted
  folder tree with status badges, `+added −deleted` stats, and rich tooltips.
- Every file opens in VS Code's native readonly diff editor.

### Stashes view

- Lists all stashes per repository with message, `stash@{n}`, branch, and age.
- Expand a stash to browse and diff its files.
- Apply, pop, or drop (with confirmation) directly from the tree; create new
  stashes with **Stash All Changes** (optionally including untracked files).

### Line blame

- Dimmed inline blame at the end of the current line — `You, 2 hours ago ·
fix: prevent duplicates` — including in unsaved buffers.
- Hover for the full commit with **Copy SHA**, **Copy Message**, and **Open
  File at This Revision** actions; the same info lives in the status bar.
- Toggle via the `Branch Compare: Toggle Inline Blame` command or settings.

### Everywhere

- Right-click any file for **Open File**, **Copy Path**, **Copy Relative
  Path**; any commit for **Copy SHA** / **Copy Commit Message**.
- **Open File at Revision...** opens the active file as it was on any branch.
- Views refresh automatically after commits, branch switches, fetches, and
  stash operations.

## Commands

Open the Command Palette and type `Branch Compare:` to see all commands. The
most common entry points:

| Command                          | Description                                       |
| -------------------------------- | ------------------------------------------------- |
| `New Comparison`                 | Pick a repository, target, and base branch        |
| `Compare Current Branch With...` | Compare the checked-out branch against a base     |
| `Stash All Changes`              | Stash the working tree, optionally with untracked |
| `Open File at Revision...`       | Open the active file at a chosen branch revision  |
| `Toggle Inline Blame`            | Show or hide current-line blame                   |

## Settings

| Setting                                | Default | Description                           |
| -------------------------------------- | ------- | ------------------------------------- |
| `branchCompare.inlineBlame.enabled`    | `true`  | Inline blame text on the current line |
| `branchCompare.statusBarBlame.enabled` | `true`  | Blame entry in the status bar         |

## Development

Requires Node 20 and VS Code ≥ 1.105.

```bash
npm install
npm run compile        # type-check and build to dist/
npm run lint           # ESLint (strict, type-checked)
npm run format:check   # Prettier
npm run test:unit      # mocha unit tests (parsers, domain, manifest)
npm run test:extension # integration tests in a real VS Code instance
npm run package        # build branch-compare-<version>.vsix
```

The VS Code task **Install VSIX (current window)** packages and installs the
extension into your running VS Code via the `code` CLI.

Documentation lives in the `docs/` folder: `PRODUCT.md` (product definition),
`ARCHITECTURE.md` (layers and components), `GIT-SEMANTICS.md` (normative Git
ranges), `TEST-MATRIX.md`, and `ROADMAP.md` (delivered and planned feature
batches).
