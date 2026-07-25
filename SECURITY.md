# Security and controlled remote handoff

## Security objective

RefHaven is designed for repositories whose data may be processed only on the
workstation or by repository services explicitly approved by the organisation.
The installed extension has no telemetry, analytics, hosted backend, HTTP
client, API authentication, runtime dependency, or automatic fetch.

The sole remote-aware feature builds GitLab browser URLs after an explicit user
command. The allowlist defaults to empty and accepts only exact HTTP(S) origins
without paths or credentials. RefHaven reads remote URLs locally, strips any
remote user information by construction, resolves refs to local immutable
SHAs, validates the final URL origin again, and then passes it to
`vscode.env.openExternal`. It never contacts a host merely because a remote
exists, never makes an HTTP/API request, never follows a redirect, and never
stores or logs remote URLs, project paths, file paths, or response data.

## Enforced runtime controls

Every Git child process is started without a shell and receives a centrally tested local-only policy:

- `GIT_ALLOW_PROTOCOL` is empty and `protocol.allow=never` is applied per command;
- `GIT_NO_LAZY_FETCH=1` prevents partial clones from fetching missing objects on demand;
- credential prompts, askpass, SSH helpers, inherited proxy commands, and protocol-from-user are disabled;
- Git packet, curl, general, and Trace2 tracing inherited from the parent process is disabled;
- inherited repository/config redirection variables are removed;
- pagers and configured `core.fsmonitor` processes are disabled;
- optional Git locks and replace-object rewriting are disabled;
- path arguments use Git's global literal-pathspec mode;
- diff operations pass `--no-ext-diff` and `--no-textconv`.

If a required object is not already available locally, the operation fails instead of contacting a remote. The extension does not activate VS Code's built-in Git extension. If that extension is already active, RefHaven reads its repository list only; all comparison data still comes from the restricted local Git process.

The only repository mutation currently implemented is the explicit
**Stash This File...** workflow. RefHaven builds a standard two-parent stash
from temporary index state, updates `refs/stash` with an expected-old-value
check, and restores only the selected tracked path or rename pair to `HEAD`.
Unrelated index and worktree state is not included or reset. Untracked files,
unmerged paths, repository metadata, and active `filter` attributes are
rejected. Every mutating plumbing command overrides `core.hooksPath` with a
private empty temporary path, preventing repository or global Git hooks from
running. The temporary index stores Git object IDs and paths, not file
contents, and is deleted after the operation.

Apply, pop, drop, multi-file stash, include-untracked, and keep-index variants
remain outside scope. RefHaven also makes the mutation non-cancellable after
it starts: terminating Git while it is updating objects, refs, or the real
index would be less safe than allowing the bounded local operation to finish.

For the same reason, the Branches and Worktrees views are read-only. They can
copy metadata, create RefHaven comparison records, and ask VS Code to open an
already enumerated local worktree, but they never checkout/create/delete a
branch or add/remove a worktree. Command arguments are checked against fresh
local Git enumeration before use.

Native-view enrichment remains inside the same boundary. Stash and File
History filters operate only on already loaded in-memory metadata. Branch
tips, upstream divergence, recent branch commits, worktree status, commit
parents, and diff statistics come from bounded transport-blocked local Git
commands. Expanding a branch or stash is the only trigger for its additional
history/statistics query; none of these views contacts a remote or persists
the displayed repository metadata.

## Stored and displayed data

Comparison specifications and comparison-review markers are persisted only in
VS Code `workspaceState`. Review records contain a comparison ID, a SHA-256
revision fingerprint, and bounded repository-relative paths; they contain no
file contents, diff hunks, commit messages, or remote data. Records are limited
to 64 comparisons, 10,000 reviewed paths and 256 KiB per comparison, with a
4 MiB total store ceiling. They are pruned when a comparison closes and
ignored when the immutable endpoints or changed-file state no longer match.
Working Tree review state is invalidated on every recalculation because that
endpoint is mutable.

Computed history, diffs, blame and annotation results, selected
changes-annotation references, and file contents are not persisted. The
non-sensitive whole-file annotation mode (`off`, `blame`, or `heatmap`) may be
saved as a VS Code user setting; comparison layout, filter, and sort choices
may be saved as workspace-local view preferences. Revision content is loaded
on demand into a bounded in-memory cache and revision URIs are authenticated
with a session-only HMAC.

Rich line hovers load commit metadata and a path-limited patch only after the
user hovers a line. Successful hover results use a 64-entry in-memory cache
keyed by document version and line and are cleared on repository refresh. Git
patch output is capped at 64 KiB and the displayed preview is capped again;
neither hover metadata nor patch content is persisted or logged.

GitLab links in line hovers are inert command URIs until clicked. Hover loading
does not enumerate remotes, open a browser, or perform network activity.

Logs exclude file contents and redact credential-, secret-, environment-, token-, and remote-related metadata. Copy commands write only the explicitly selected value to the operating-system clipboard.

## Trust boundaries

The guarantee above covers RefHaven and the Git processes it creates. The following components are outside the extension's control and must be governed by workstation policy:

- the installed VS Code and Git binaries;
- other extensions, including VS Code's built-in Git autofetch setting;
- operating-system clipboard history or cloud clipboard synchronization;
- the browser opened by `vscode.env.openExternal`, including its
  authentication, extensions, proxy, DNS, redirect, and history policies;
- repositories or object stores located on network-mounted filesystems;
- development-time package installation and Extension Host test downloads.

Local Git configuration remains trusted for identity, attributes, object
format, line-ending, and working-tree encoding semantics. RefHaven blocks
network transports, hooks, content filters, external diff/textconv,
fsmonitor, prompts, and inherited process redirection for its own stash
sequence; it cannot prevent another extension, terminal, or concurrent local
process from running a different Git command.

For a fully isolated workstation, disable `git.autofetch`, disable clipboard synchronization, use approved local Git/VS Code builds, and install the VSIX from an internally verified artifact. These controls are defense in depth; RefHaven itself neither enables nor calls remote Git operations.

For GitLab links, approve only organisation-controlled origins. RefHaven
validates the URL handed to the operating system but cannot constrain what an
external browser does after navigation, including server-directed redirects.
No GitLab API token or browser credential is read by the extension.

## Supply-chain policy

The VSIX contains compiled extension code and documentation only; development dependencies are excluded with `vsce package --no-dependencies`. Production dependencies are prohibited. Development dependencies are exact-pinned in `package.json`, integrity-pinned in `package-lock.json`, kept minimal, and checked with `npm audit` before release.

Security updates take precedence over feature updates. A newer development package is not adopted when it requires an unsupported runtime or introduces a known advisory; the newest compatible audit-clean version is retained until a safe upgrade is available.
