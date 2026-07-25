# Security and local-only operation

## Security objective

RefHaven is designed for repositories whose paths, refs, history, metadata, and file contents must remain on the workstation. The installed extension has no telemetry, analytics, authentication, remote-service integration, networking API, runtime dependency, or automatic fetch. It never sends repository data to a vendor or hosted service.

## Enforced runtime controls

Every Git child process is started without a shell and receives a centrally tested local-only policy:

- `GIT_ALLOW_PROTOCOL` is empty and `protocol.allow=never` is applied per command;
- `GIT_NO_LAZY_FETCH=1` prevents partial clones from fetching missing objects on demand;
- credential prompts, askpass, SSH helpers, inherited proxy commands, and protocol-from-user are disabled;
- Git packet, curl, general, and Trace2 tracing inherited from the parent process is disabled;
- inherited repository/config redirection variables are removed;
- pagers and configured `core.fsmonitor` processes are disabled;
- optional Git locks and replace-object rewriting are disabled;
- diff operations pass `--no-ext-diff` and `--no-textconv`.

If a required object is not already available locally, the operation fails instead of contacting a remote. The extension does not activate VS Code's built-in Git extension. If that extension is already active, RefHaven reads its repository list only; all comparison data still comes from the restricted local Git process.

RefHaven performs no repository mutation. Stashes can be listed and inspected, but creating, applying, popping, or dropping them is intentionally outside scope: those Git operations can invoke repository-configured filters or merge drivers that cannot be sandboxed reliably across Windows, Linux, and macOS.

For the same reason, the Branches and Worktrees views are read-only. They can
copy metadata, create RefHaven comparison records, and ask VS Code to open an
already enumerated local worktree, but they never checkout/create/delete a
branch or add/remove a worktree. Command arguments are checked against fresh
local Git enumeration before use.

## Stored and displayed data

Only comparison specifications are persisted, in VS Code `workspaceState`. Computed history, diffs, blame results, and file contents are not persisted. Revision content is loaded on demand into a bounded in-memory cache and revision URIs are authenticated with a session-only HMAC.

Logs exclude file contents and redact credential-, secret-, environment-, token-, and remote-related metadata. Copy commands write only the explicitly selected value to the operating-system clipboard.

## Trust boundaries

The guarantee above covers RefHaven and the Git processes it creates. The following components are outside the extension's control and must be governed by workstation policy:

- the installed VS Code and Git binaries;
- other extensions, including VS Code's built-in Git autofetch setting;
- operating-system clipboard history or cloud clipboard synchronization;
- repositories or object stores located on network-mounted filesystems;
- development-time package installation and Extension Host test downloads.

For a fully isolated workstation, disable `git.autofetch`, disable clipboard synchronization, use approved local Git/VS Code builds, and install the VSIX from an internally verified artifact. These controls are defense in depth; RefHaven itself neither enables nor calls remote Git operations.

## Supply-chain policy

The VSIX contains compiled extension code and documentation only; development dependencies are excluded with `vsce package --no-dependencies`. Production dependencies are prohibited. Development dependencies are exact-pinned in `package.json`, integrity-pinned in `package-lock.json`, kept minimal, and checked with `npm audit` before release.

Security updates take precedence over feature updates. A newer development package is not adopted when it requires an unsupported runtime or introduces a known advisory; the newest compatible audit-clean version is retained until a safe upgrade is available.
