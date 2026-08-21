# RefHaven

> **Your Git context, inside VS Code. Your repository data, under your control.**

RefHaven brings branch comparisons, line intelligence, history, stashes, and
repository navigation into one fast, native VS Code experience.

It is built for private and security-sensitive repositories:

**No telemetry** · **No backend** · **No webviews** · **No runtime
dependencies** · **No background network activity**

---

## See what changed. Understand why. Keep moving.

|                        | What you need                       | What RefHaven gives you                                                        |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| 🔀 **Review locally**  | Understand and review a change      | Comparisons, merge forecast, native diffs, review progress, bounded patches    |
| 🧭 **Understand code** | Explain a line or scan a whole file | Rich hover, blame, heatmap, history, readonly revisions, local commit search   |
| 🛡️ **Act safely**      | Change or leave the local workspace | Fail-safe single-file stash and explicit links to validated repository origins |

All of this uses VS Code's native trees, editors, hovers, menus, quick picks,
and Source Control sidebar.

## Start in under a minute

1. Install the RefHaven VSIX.
2. Open a trusted Git repository, or any folder inside one.
3. Open **Source Control**.
4. Run **RefHaven: New Comparison** from `Ctrl+Shift+P`.
5. Pick the branch you want to review and its base.

RefHaven focuses the Source Control sidebar, reveals the new comparison,
expands it, and loads its differences locally.

No account, token, server, repository configuration, or onboarding wizard is
required.

When the opened folder is below the repository root, RefHaven treats the
containing repository as the local Git scope. This makes the same features
available in `.code-workspace` and Remote SSH layouts without requiring the
repository root itself to be a workspace folder.

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

Inline and status-bar blame stay deliberately compact. The rich hover keeps
the most relevant diff and revision actions visible and collects the complete
context-sensitive set under **More Actions...**.

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

- **Blame** — readable author, relative age, and commit summary annotations.
  Contiguous lines from one commit are grouped visually; full details remain on
  every hover. The format and repetition are configurable.
- **Heatmap** — scan the file through fixed, predictable age bands. It uses a
  compact editor-edge strip plus the overview ruler by default, distinguishes
  uncommitted lines from recent commits, and keeps blame details on hover.
- **Changes relative to...** — mark saved and unsaved editor lines changed from
  a selected local reference. The symbolic baseline survives window reloads in
  this workspace and follows the reference after Git updates.
- **Off** — the default; no whole-file annotation cost.

The heatmap legend is available from the unified file-actions menu. It reports
live line counts and percentages for the active file, so the visualization
never depends on color alone. Select a populated band to jump to its first
line:

| Band          | Meaning                                 |
| ------------- | --------------------------------------- |
| Working tree  | Uncommitted                             |
| Last 24 hours | Committed within the last 24 hours      |
| Last 7 days   | More than 24 hours and up to 7 days ago |
| Last 30 days  | More than 7 and up to 30 days ago       |
| Last year     | More than 30 and up to 365 days ago     |
| Older         | Committed more than one year ago        |

The default visualization is deliberately compact: a narrow strip at the
right edge of each line plus markers in the overview ruler. It does not tint
the code background, and a file whose lines have similar ages can therefore
look almost uniform. For an unmistakable full-file view, add `"line"` to
`refhaven.fileAnnotations.heatmap.locations`. The direct-toggle confirmation
reports how many blameable lines and age bands were rendered, together with the
active placements.

Use **RefHaven: Toggle File Heatmap** for a direct on/off action. By default it
affects only the active file; set `refhaven.fileAnnotations.heatmap.toggleMode`
to `"window"` when you want the choice persisted for the whole window. Press
`Escape` to dismiss active whole-file annotations without rewriting that
preference. Add `"line"` to `refhaven.fileAnnotations.heatmap.locations` for a
stronger full-line tint. Every band exposes `Foreground` and `Background`
theme tokens under `refhaven.heatmap.*`, customizable with VS Code's
`workbench.colorCustomizations`. Whole-file blame uses
`refhaven.blame.annotationForeground`.

Annotations are native, cancellable, bounded to 5,000 editor lines, and their
calculated results are never persisted. Only the selected changes baseline is
stored in VS Code workspace state. Whole-file annotations remain off by default
so there is no repository-wide blame work unless you opt in.

If a heatmap appears empty, open a non-empty tracked file with at most 5,000
lines and choose **RefHaven: Change File Annotations...** > **File heatmap**.
This is deterministic; **Toggle File Heatmap** may instead turn an already
active heatmap off. Then open **Show File Heatmap Legend**: it refreshes stale
data and explains inactive or non-blameable files instead of showing an empty
picker.

</details>

<details>
<summary><strong>📚 File and line history</strong></summary>

- **Inspector → File History** follows the active editor until you pin it.
- Rename tracking uses local `git log --follow`, is on by default, and is shown
  directly in the section header. Use its inline action or **Enable/Disable
  Rename Tracking** from the Command Palette; the choice is kept per workspace.
- Histories load 50 revisions at a time. **Load older revisions…** appends the
  next page without discarding the current one and can be cancelled.
- Filters cover the revisions already loaded and match commit, author, SHA, or
  path metadata.
- Run **Show Line History** to replace the section with the selected line range;
  it is pinned automatically so opening a diff cannot lose the selection.
- Open file and line changes as native diffs, then navigate newer or older
  loaded revisions.
- Open any tracked file at a locally available revision.
- Compare the working-tree file with a selected revision.

</details>

<details>
<summary><strong>📦 Single-file stash and inspection</strong></summary>

**Stash This File...** stores the staged and unstaged state of one tracked
regular file—or both sides of its detected rename—in a standard Git stash,
then returns only that selection to `HEAD`. Unrelated changes stay in place. An
accepted command saves an unsaved selected editor before beginning.

The transaction is deliberately fail-closed: it uses compare-and-swap checks,
atomic file operations, and a retained recovery journal so a concurrent editor
or Git process wins instead of being overwritten. Unsupported path, index,
filter, sparse-checkout, and filesystem cases stop without broadening the
mutation. The exact safety protocol, recovery procedure, and limits are in
[`docs/GIT-SEMANTICS.md`](docs/GIT-SEMANTICS.md) and [`SECURITY.md`](SECURITY.md).

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
  author, SHA, or added/removed content. Message and author searches offer
  literal/regular-expression and case controls; content search offers the same
  controls with POSIX extended-regex semantics.
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
| 🗂️ **VS Code workspace state**                   | Comparisons, review markers, selected annotation baseline  |
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

| Command                                 | Use it when you want to...                         |
| --------------------------------------- | -------------------------------------------------- |
| `New Comparison`                        | Review any two locally available refs              |
| `Compare Current Branch With...`        | Start from the checked-out branch                  |
| `Search Commits`                        | Find local history by metadata or changed content  |
| `Show File History`                     | Follow the active file through paged local history |
| `Show Line History`                     | Trace and pin the current selection in Inspector   |
| `Inspect Current Line`                  | Open rich blame actions for the cursor line        |
| `Open File at Revision...`              | Read a historical version                          |
| `Compare File with Revision...`         | Diff the current file against a local ref          |
| `Change File Annotations...`            | Enable blame, heatmap, or changes markers          |
| `Toggle File Heatmap`                   | Enable or disable the heatmap directly             |
| `Show File Actions`                     | Open the context-sensitive native action menu      |
| `Stash This File...`                    | Safely set aside one tracked file                  |
| `Configure Restricted Remote Origin...` | Enable or clear the strict remote-origin policy    |
| `Line Intelligence`                     | Choose Full, Hover only, or Off                    |

The editor, Explorer, Source Control resources, tree nodes, and blame status
entry also expose context-sensitive RefHaven actions.

## Settings

RefHaven works immediately with its defaults.

| Setting                                       | Default                | Purpose                                  |
| --------------------------------------------- | ---------------------- | ---------------------------------------- |
| `refhaven.inlineBlame.enabled`                | `true`                 | Current-line inline blame                |
| `refhaven.statusBarBlame.enabled`             | `true`                 | Current-line blame in the status bar     |
| `refhaven.lineHover.enabled`                  | `true`                 | Rich local hover on tracked lines        |
| `refhaven.fileAnnotations.mode`               | `off`                  | Default whole-file annotation mode       |
| `refhaven.fileAnnotations.blame.format`       | `detailed`             | Whole-file blame detail level            |
| `refhaven.fileAnnotations.blame.showRepeated` | `false`                | Repeat details inside commit blocks      |
| `refhaven.fileAnnotations.heatmap.locations`  | `["edge", "overview"]` | Placement; optional `"line"` tint        |
| `refhaven.fileAnnotations.heatmap.toggleMode` | `file`                 | Direct-toggle scope: file or window      |
| `refhaven.git.timeoutSeconds`                 | `30`                   | Per-command Git timeout, from 1 to 300 s |
| `refhaven.browserLinks.approvedOrigins`       | `[]`                   | Optional strict browser-origin allowlist |

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
npm run benchmark:annotations
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
- Feature maturity and competitive gaps — `docs/FEATURE-MATURITY.md`
- Architecture — `docs/ARCHITECTURE.md`
- Security model — `SECURITY.md`
- Privacy notice — `PRIVACY.md`
- Implementation and asset provenance — `IP-PROVENANCE.md`
- Public publishing checklist — `docs/PUBLISHING.md`
- Release evidence template — `docs/RELEASE-REPORT-TEMPLATE.md`
- Git comparison semantics — `docs/GIT-SEMANTICS.md`
- Dependency policy — `docs/DEPENDENCIES.md`
- Maintainability standards — `docs/MAINTAINABILITY.md`
- Test matrix — `docs/TEST-MATRIX.md`
- Roadmap — `docs/ROADMAP.md`
- Contributing — `CONTRIBUTING.md`
