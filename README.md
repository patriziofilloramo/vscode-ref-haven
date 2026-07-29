# RefHaven

> **Your Git context, inside VS Code. Your repository data, under your control.**

RefHaven brings branch comparisons, line intelligence, history, stashes, and
repository navigation into one fast, native VS Code experience.

It is built for private and security-sensitive repositories:

**No telemetry** · **No backend** · **No webviews** · **No runtime
dependencies** · **No background network activity**

---

## See what changed. Understand why. Keep moving.

|                        | What you need                       | What RefHaven gives you                                             |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| 🔀 **Compare**         | Understand a feature branch         | Commits, changed files, statistics, native diffs, review progress   |
| 🧭 **Investigate**     | Understand a suspicious line        | Author, commit, dates, previous diff, file history, line history    |
| 📚 **Time travel**     | Inspect a file at an older revision | Readonly historical documents and native revision comparisons       |
| 📦 **Stash one file**  | Set aside one tracked file safely   | Staged/unstaged state, fail-closed cleanup, and recovery copies     |
| 🔎 **Inspect stashes** | Review work already saved by Git    | Expandable files, statistics, revisions, history, and native diffs  |
| 🌿 **Navigate**        | Inspect branches and worktrees      | Local metadata, divergence, recent commits, state, quick actions    |
| 🔗 **Open safely**     | Continue on your repository host    | Explicit links to validated repository origins—never a RefHaven API |

All of this uses VS Code's native trees, editors, hovers, menus, quick picks,
and Source Control sidebar.

## Start in under a minute

1. Install the RefHaven VSIX.
2. Open a trusted folder containing a Git repository.
3. Open **Source Control**.
4. Run **RefHaven: New Comparison** from `Ctrl+Shift+P`.
5. Pick the branch you want to review and its base.

RefHaven focuses the Source Control sidebar, reveals the new comparison,
expands it, and loads its differences locally.

No account, token, server, repository configuration, or onboarding wizard is
required.

## Using RefHaven with another blame extension

RefHaven shows three things on the current line: inline blame at the end of the
line, a hover, and a status bar entry. VS Code does not arbitrate between
extensions here — it draws every extension's decorations and merges every
extension's hovers. If another extension already shows blame, both appear and
the line reads twice.

Run **RefHaven: Line Intelligence** from `Ctrl+Shift+P` and choose:

| Mode           | What stays                                         |
| -------------- | -------------------------------------------------- |
| **Full**       | Inline blame, hover, status bar (default)          |
| **Hover only** | Just the hover — removes the duplicate on the line |
| **Off**        | No per-line surfaces                               |

One limit worth knowing: VS Code merges every extension's hover into a single
widget, and an extension can only withhold its own. With two blame extensions
the hover still shows both cards. To see one, use **Off**, set
`refhaven.lineHover.enabled` to `false` while keeping the line text, or turn
off hovers in the other extension.

Everything else — comparisons, review tracking, history, stashes, patch export,
merge forecast — never overlaps, so keeping both extensions installed is a
perfectly reasonable setup.

## A typical review

Imagine you are reviewing `feature/oauth` against `main`.

1. Create `feature/oauth relative to main`.
2. Expand **Ahead** to understand the feature's commits.
3. Expand **Files changed** and open native diffs.
4. Mark files reviewed as you progress.
5. Filter to **Unreviewed** and jump to the next remaining file.
6. Copy or save a bounded unified patch when you need to share the result.

The comparison survives reloads. You can rename it to something meaningful
like `OAuth release audit`, pin it, reverse its direction, or switch between:

- **Branch changes** — what the target introduced since the merge base.
- **Tip to tip** — every difference between the two branch tips.
- **Working Tree** — an immutable base compared with current tracked changes.

## Feature tour

<details open>
<summary><strong>🔀 Branch comparisons</strong></summary>

The **Branch Comparisons** view is the central review workspace.

- Compare local branches, remote-tracking branches, tags, `HEAD`, typed local
  revisions, or the Working Tree.
- Browse ahead/behind commits and expand a commit into its changed files.
- View changed files as a flat list or compacted folder tree.
- See status, additions, deletions, tooltips, and clear empty-state
  explanations.
- Open every change in VS Code's native readonly diff editor.
- **Merge forecast**: see at a glance whether the target would merge cleanly
  into the base. Conflicts appear on the comparison row (`⚠ 2 merge
conflicts`) with the conflicted files named in the tooltip — computed
  entirely in memory, without touching your worktree, index, or branches.
  Requires Git 2.38+; older Git simply shows no forecast.
- Filter, sort, Quick Open, mark reviewed, and navigate remaining files.
- Pin, rename, refresh, swap, change mode, or close saved comparisons.
- Copy a complete comparison patch or a patch for one selected file. Saved
  patches preserve the exact file bytes, so legacy-encoded content still
  applies cleanly with `git apply`.

</details>

<details>
<summary><strong>🧠 Rich line intelligence</strong></summary>

Hover any tracked line to answer more than “who changed this?”

- Author and email.
- Relative and exact commit times, at the precision that distance makes useful.
- Full commit SHA and message.
- Original file path and line.
- Commit and file statistics.
- A compact previous-revision diff.
- Actions for commit details, previous/working-tree diffs, file history, line
  history, open-at-revision, and copy.

Optional inline blame keeps the current line concise:

```text
You, 2 hours ago (14:32) · fix: reject unsafe revision paths
```

The same hover works in RefHaven's historical readonly documents, so you can
walk a line backwards through time.

</details>

<details>
<summary><strong>🎨 Whole-file annotations</strong></summary>

Use **RefHaven: Change File Annotations...** when you need a wider view:

- **Blame** — author and age markers for every line.
- **Heatmap** — color lines by the age of their last commit.
- **Changes relative to...** — mark working-tree lines changed from a selected
  local revision.
- **Off** — the default; no whole-file annotation cost.

Annotations are native, cancellable, bounded, and never persisted.

</details>

<details>
<summary><strong>📚 File and line history</strong></summary>

- The **Inspector → File History** section follows the active file across
  renames.
- Filter revisions by commit, author, SHA, or path metadata.
- Open historical changes as native diffs.
- Navigate older and newer visible revisions.
- Run **Show Line History** for the current editor selection.
- Open any tracked file at a locally available revision.
- Compare the working-tree file with a selected revision.

</details>

<details>
<summary><strong>📦 Single-file stash and inspection</strong></summary>

**Stash This File...** stores the staged and unstaged state of one tracked
regular file—or both sides of its detected rename—in a standard two-parent Git
stash, then returns only that selection to `HEAD`. Untracked files are excluded,
and every unrelated staged or working-tree change stays exactly where it was.
The command is available from the unified RefHaven file submenu in Source
Control, Explorer, and editors, plus the Command Palette. If the selected
editor has unsaved changes, confirming the stash message saves that document
before the Git transaction begins.

The cleanup is deliberately fail-safe. RefHaven first publishes the stash and
a private recovery ref in one atomic ref transaction,
atomically moves the selected file into a repository-local safety directory inside the
repository's Git metadata, verifies the moved bytes, and installs the clean
`HEAD` file with a no-clobber hard link. The full index is captured byte for
byte; RefHaven installs the prepared clean index only after acquiring
`index.lock` and confirming that the real index still matches that capture. If another editor or
process writes the path, moves `HEAD`, or changes the selected index entry,
RefHaven stops instead of overwriting the newer state. `refs/stash` itself is
published with an expected-old-value check, so a competing stash update wins
safely before cleanup starts. A stash may therefore be created while cleanup
is reported as incomplete; the warning identifies that outcome and offers the
safety directory for inspection.

When an existing file is moved during a successful stash, its safety copy and
completion journal are retained under the repository's
`refhaven-recovery/stash-*` Git metadata directory. This is intentional: an
editor that already had the original file open can still write through its old
file handle. Close editors and other writers, verify both the stash and current
file, and only then remove an obsolete safety directory manually. RefHaven
does not delete these directories automatically. If an incomplete journal has
a non-null `recoveryRef`, first delete that ref with its expected stash SHA
(`git update-ref -d <recoveryRef> <stashSha>`), then remove the directory.

Save the selected VS Code document before running the command. RefHaven fails
closed for untracked or conflicted paths, active Git content filters, sparse
checkout or skip-worktree entries, symlinks, submodules and other special
index entries, files over 64 MiB, or a worktree whose path cannot use atomic
rename and hard links with the Git safety directory. Stash apply/pop/drop,
multi-file stash,
include-untracked, and keep-index workflows remain outside RefHaven.

The **Stashes** view lets you inspect existing stash files, statistics,
revisions, history, and native comparisons without applying or dropping them.

</details>

<details>
<summary><strong>🌿 Branches, worktrees, and commits</strong></summary>

- **Repository → Branches** shows upstream state, ahead/behind counts, tip metadata, and
  bounded recent local history. Select two branches and run **Compare Selected
  Branches** to choose the target and create the comparison directly.
- **Repository → Worktrees** shows branch/detached state, HEAD, lock state, and local working
  status.
- **Search Commits** searches already available local history by message,
  author, SHA, or changed content.
- **Inspector → Commit Details** shows complete metadata, parents, changed files, and
  parent comparisons.

Branch and worktree views remain read-only: RefHaven does not checkout,
create, delete, or rewrite them.

</details>

<details>
<summary><strong>🔗 Validated browser links</strong></summary>

RefHaven can open a project, commit, comparison, branch revision, file, issue,
or merge/pull request on the repository's own host. Project, commit, branch,
comparison, and file actions can also copy the same fully validated URL
without opening a browser.

GitHub, GitLab, Bitbucket, and Gitea/Forgejo/Codeberg are supported, each with
its own URL grammar: the `/-/` scope segment, `/blob/` versus `/src/commit/`,
`#L10-L12` versus `#lines-10:12`, and four different names for a merge or pull
request. The grammar is detected from the remote's hostname alone — RefHaven
never asks the host what it is.

Detection is exact for the public hostnames and a heuristic for self-hosted
instances, where it reads the leading label (`gitlab.company.example`) and
falls back to GitLab. When that guess is wrong, set
`refhaven.browserLinks.hostGrammar` explicitly. Where a correct link cannot be
built — Azure DevOps, which addresses files through query parameters, or a
Bitbucket comparison, which has no stable commit-to-commit address — RefHaven
offers no link rather than one that opens an empty page.

By default it derives a validated browser origin from the repository's local
remote configuration. To enforce an exact allowlist instead, run
**RefHaven: Configure Restricted Remote Origin...** from `Ctrl+Shift+P`. Enter
one exact origin, or submit an empty value to restore the zero-configuration
behavior. The JSON setting remains available for advanced multi-origin
policies:

```json
"refhaven.browserLinks.approvedOrigins": [
  "https://gitlab.company.example:8443"
]
```

An empty list means zero-configuration validated remotes. A non-empty list
becomes a strict allowlist.

RefHaven performs no HTTP request, API call, authentication, redirect
following, or background discovery. The browser opens only after an explicit
user command.

</details>

## Where your data goes

| Destination                                      | RefHaven behavior                                          |
| ------------------------------------------------ | ---------------------------------------------------------- |
| 💻 **Your workstation**                          | Git processing, comparisons, history, blame, caches        |
| 🗂️ **VS Code workspace state**                   | Saved comparison definitions and bounded review markers    |
| 📋 **Operating-system clipboard**                | Only values you explicitly choose to copy                  |
| 🌐 **Your validated remote origin**              | Only a browser URL opened after your explicit command      |
| 🚫 **RefHaven servers, analytics, AI providers** | Never—RefHaven has no such service, client, token, or path |

Every Git process:

- runs without a shell;
- executes an absolute Git binary resolved once from your configured
  `git.path` or the absolute directories on `PATH`—never a bare name;
- blocks transports and partial-clone lazy fetch;
- disables prompts, tracing, pagers, fsmonitor, external diff, and textconv;
- rejects working-tree paths with active content filters instead of returning
  an approximation while their executable drivers are disabled;
- uses literal validated paths;
- has bounded concurrency, input/output limits, timeouts, and cancellation.

Operational logs exclude exception messages and redact repository-derived or
sensitive metadata.

This "no egress" guarantee is **enforced by the build, not just promised**: a
data-egress guard test fails the moment any source file gains a network call,
a code-execution primitive, telemetry, or an unaudited process or browser
handoff. Run `npm run test:unit` and read the "data-egress guard" results, or
see the _Verify it yourself_ section of `PRIVACY.md`. A shareable attestation
(EN/DE/IT) lives in
[`docs/security-attestation.html`](docs/security-attestation.html).

See `SECURITY.md` for the complete threat model and `PRIVACY.md` for the
concise data-handling notice.

## Everyday commands

Open `Ctrl+Shift+P` and type `RefHaven`.

| Command                                     | Use it when you want to...                          |
| ------------------------------------------- | --------------------------------------------------- |
| `New Comparison`                            | Review any two locally available refs               |
| `Compare Current Branch With...`            | Start from the checked-out branch                   |
| `Compare Selected Branches`                 | Compare two branches selected under Repository      |
| `Open All Changes`                          | Review every text change in one native editor       |
| `Quick Open Comparison File...`             | Find a changed file without navigating the tree     |
| `Open Next Unreviewed File`                 | Continue a comparison review                        |
| `Search Commits`                            | Find local history by metadata or changed content   |
| `Show File History`                         | Follow the active file across revisions and renames |
| `Show Line History`                         | Trace the current selection                         |
| `Inspect Current Line`                      | Open rich blame actions for the cursor line         |
| `Open File at Revision...`                  | Read a historical version                           |
| `Compare File with Revision...`             | Diff the current file against a local ref           |
| `Reveal File in Branch Comparison`          | Find the active file in a saved comparison          |
| `Change File Annotations...`                | Enable blame, heatmap, or changes markers           |
| `Show File Actions`                         | Open the context-sensitive native action menu       |
| `Stash This File...`                        | Safely set aside one tracked file                   |
| `Open Local Reference in Browser...`        | Open a validated immutable revision in the browser  |
| `Open Issue or Merge Request in Browser...` | Open a validated `#issue` or `!merge-request`       |
| `Configure Restricted Remote Origin...`     | Enable or clear the strict remote-origin policy     |

The editor, Explorer, Source Control resources, tree nodes, and blame status
entry also expose context-sensitive RefHaven actions.

## Settings

RefHaven works immediately with its defaults.

| Setting                                 | Default | Purpose                                  |
| --------------------------------------- | ------- | ---------------------------------------- |
| `refhaven.inlineBlame.enabled`          | `true`  | Current-line inline blame                |
| `refhaven.statusBarBlame.enabled`       | `true`  | Current-line blame in the status bar     |
| `refhaven.lineHover.enabled`            | `true`  | Rich local hover on tracked lines        |
| `refhaven.fileAnnotations.mode`         | `off`   | Default whole-file annotation mode       |
| `refhaven.git.timeoutSeconds`           | `30`    | Per-command Git timeout, from 1 to 300 s |
| `refhaven.browserLinks.approvedOrigins` | `[]`    | Optional strict browser-origin allowlist |

## Installation

To install an internally supplied build:

1. Open the VS Code **Extensions** view.
2. Select the `...` menu.
3. Choose **Install from VSIX...**
4. Select `refhaven-<version>.vsix`.

RefHaven development uses supported Node.js LTS lines: Node 22.13 or newer
within the Node 22 line, or Node 24. VS Code 1.105 or newer is required.

## Development and release gates

```bash
npm install
npm run compile
npm run lint
npm run quality
npm run format:check
npm run test:unit
npm run test:extension
npm audit --audit-level=low
npm audit signatures
npm run package
```

The project ships with zero production dependencies. Development dependencies
are minimal, exact-pinned, lockfile-integrity pinned, and excluded from the
VSIX.

`npm run package` builds an internal VSIX. For a public artifact,
`npm run marketplace:check` validates the release metadata and publication
safeguards, then `npm run package:release` builds the reviewed VSIX while
`private: true` continues to block accidental npm publication. Complete the
remaining account and repository checks in the publishing checklist before
publishing it.

## Documentation

- Release history — `CHANGELOG.md`
- Product definition — `docs/PRODUCT.md`
- Architecture — `docs/ARCHITECTURE.md`
- Security model — `SECURITY.md`
- Privacy notice — `PRIVACY.md`
- Implementation and asset provenance — `IP-PROVENANCE.md`
- Public publishing checklist — `docs/PUBLISHING.md`
- Git comparison semantics — `docs/GIT-SEMANTICS.md`
- Dependency policy — `docs/DEPENDENCIES.md`
- Maintainability standards — `docs/MAINTAINABILITY.md`
- Test matrix — `docs/TEST-MATRIX.md`
- Roadmap — `docs/ROADMAP.md`
- Contributing — `CONTRIBUTING.md`
