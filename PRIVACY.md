# Privacy notice

## Summary

RefHaven processes repository data on the workstation. It has no telemetry,
analytics, hosted backend, HTTP client, API client, advertising, account
system, remote configuration service, or background network activity.

The extension does not send repository content, file paths, branch names,
commit metadata, usage events, diagnostics, or identifiers to RefHaven or to
any third-party processing service.

## Data processed locally

RefHaven runs the installed Git executable with bounded, transport-disabled
commands to calculate comparisons, history, blame, stash information, commit
details, patches, and repository navigation metadata. Results are rendered in
native VS Code views and editors.

Saved comparison definitions and bounded reviewed-file markers are stored in
VS Code workspace state. File contents, patches, commit messages, blame
results, history results, and generated GitLab URLs are not persisted by
RefHaven. Operational logs exclude exception messages and redact
repository-derived and sensitive metadata.

## Explicit user handoffs

RefHaven transfers data outside its process only after a direct user action:

- copy commands place the selected value or locally generated patch on the
  operating-system clipboard;
- save commands write a patch only to the local filesystem location selected
  by the user;
- GitLab commands construct a validated URL for the repository's configured
  GitLab origin and either copy it or ask VS Code to open it in the external
  browser.

GitLab support uses no API, token, authentication flow, redirect handling, or
background discovery. By default, the browser origin is inferred from a
validated local Git remote. If `refhaven.gitLab.approvedOrigins` is configured,
its exact origins become a strict allowlist.

## Verify it yourself

These guarantees are not a matter of trust. You can confirm them on the exact
bytes you install:

- **No runtime dependencies.** `package.json` declares an empty `dependencies`
  object, so no third-party code runs inside the extension host. The packaged
  VSIX contains only compiled JavaScript, the icon, and three documents — no
  source, no `node_modules`, no other payload. Inspect it with any archive
  tool, or run `npx --yes @vscode/vsce ls` in the extension folder.
- **No network egress, enforced by the build.** The test suite includes a
  data-egress guard (`test/unit/egressGuard.test.ts`) that scans every source
  file and fails if any of them gains a network primitive (`fetch`, `http`,
  `https`, `net`, `WebSocket`, …), a code-execution primitive (`eval`,
  dynamic `import`), telemetry, or an unaudited process or browser handoff.
  Process execution is confined to one file and the browser handoff to one
  file. Run `npm run test:unit` and read the "data-egress guard" results.
- **Git cannot reach the network.** Every Git process is started with
  `-c protocol.allow=never` and an empty `GIT_ALLOW_PROTOCOL`, which refuse
  every transport (`http`, `https`, `ssh`, `git`, `ftp`). Proxy, SSH, external
  diff, pager, and inherited repository-redirection environment variables are
  cleared, and commands run without a shell. See `gitProcessPolicy.ts` and its
  test.

The only way repository data leaves the extension is one of the explicit,
user-initiated handoffs listed above.

## Components outside RefHaven

The privacy guarantees above apply to RefHaven and the Git processes it starts.
VS Code, Git, other extensions, operating-system clipboard history or cloud
clipboard synchronization, network-mounted filesystems, and the external
browser are governed by their own configuration and policies.

For the complete technical trust boundary and hardening controls, see
[SECURITY.md](SECURITY.md).
