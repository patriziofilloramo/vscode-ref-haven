# Git semantics

This document is normative. Command ranges or result direction must not change without corresponding tests, documentation updates, and an ADR when the change affects a protected design decision.

For every example:

```text
baseRef   = refs/heads/main
targetRef = refs/heads/feature/oauth
```

The extension passes arguments directly to Git without a shell. Every command is prefixed with the local-only configuration defined in [SECURITY.md](../SECURITY.md), including blocked transports and lazy fetch. Before calculation it resolves both selected symbolic refs to immutable commit SHAs. Saved comparisons retain symbolic refs; calculated results and revision documents use SHAs.

All filesystem path arguments use Git's global `--literal-pathspecs` mode in
addition to `--`, so characters with pathspec meaning are never interpreted as
patterns or magic signatures.

## Ahead and behind

Run the equivalent of:

```text
git rev-list --left-right --count <base>...<target>
```

The first count is reachable only from the base and the second only from the target:

```ts
behind = leftCount;
ahead = rightCount;
```

Target-only commits use `git log <base>..<target>`. Base-only commits use `git log <target>..<base>`. The Git client uses a machine-readable, unambiguous log format and paginates each side independently, initially 50 commits at a time. UI labels are `Commits only in <target>` and `Commits only in <base>`, not isolated Ahead/Behind headings.

## Merge base and comparison modes

The common ancestor is obtained with:

```text
git merge-base <base> <target>
```

`--fork-point` is not the default because its reflog-dependent semantics do not describe arbitrary branch pairs reliably.

### Branch changes

This mode shows changes introduced by the target since the common point:

```text
fromSha = merge-base(base, target)
toSha   = targetSha
git diff <fromSha> <toSha>
```

If no merge base exists, this mode returns `noCommonAncestor`, retains the comparison, explains that the histories are unrelated, and offers switching to tip-to-tip.

### Tip-to-tip

This mode compares current trees, including base changes absent from the target:

```text
fromSha = baseSha
toSha   = targetSha
git diff <fromSha> <toSha>
```

It remains available for unrelated histories. The file section always names the active mode.

## Changed-file parser

File identity and status come from the equivalent of:

```text
git diff --no-ext-diff --no-textconv --name-status -z --find-renames <fromSha> <toSha> --
```

`-z` is mandatory. The parser operates on NUL-delimited fields and must not assume one record per line or tab-safe paths. It supports spaces, tabs, newlines, Unicode, and empty output.

Recognised status prefixes map to domain states:

| Git                               | Domain state | Paths              |
| --------------------------------- | ------------ | ------------------ |
| `A`                               | added        | new path           |
| `M`                               | modified     | path               |
| `D`                               | deleted      | old path           |
| `R[score]`                        | renamed      | old path, new path |
| `C[score]`                        | copied       | old path, new path |
| `T`                               | typeChanged  | path               |
| `U` and applicable unmerged forms | unmerged     | path               |

Rename and copy scores are optional numeric similarity values. Unknown or malformed statuses produce typed parser errors; they are not silently coerced.

## Metadata and history framing

Commit lists, followed file history, branch details, stash lists, and full
commit details use explicit `%x00` fields. NUL is the only safe shared framing
byte because Git forbids it in identities, refs, messages, and paths. Record
parsers consume an exact field count; file history additionally consumes the
validated one- or two-path name-status record emitted by `-z`. Characters such
as `0x1e`, `0x1f`, tabs, and newlines remain data and never delimit records.

`%at`, `%(authordate:unix)`, and equivalent timestamps must be complete
non-negative decimal values inside the JavaScript `Date` range. Partial
numbers, negative values, unsafe integers, and out-of-range dates are rejected
without echoing the malformed Git field in user-visible errors or logs.
The same non-echo rule applies to malformed object IDs, status codes, numstat
records, and worktree metadata: parser errors describe the failed contract but
never interpolate repository-controlled fields.

File and line history request one record beyond the 50-row UI page so the tree
can expose **Load older revisions…** without first counting the repository.
Followed file history restarts from the last displayed commit and path, verifies
that boundary, then removes its single duplicate row. It does not use `--skip`:
skipping a simplified `--follow` walk can lose the continuation at a rename
boundary. Line history replays the same bounded `git log -L` query with a
validated offset because Git owns the historical line-range mapping. A new
target, refresh, follow-mode change, or user cancellation aborts the active Git
process; completed pages remain available when loading a later page fails.

## Numstat

Statistics are obtained separately:

```text
git diff --no-ext-diff --no-textconv --numstat -z --find-renames <fromSha> <toSha> --
```

For comparisons involving the working tree, RefHaven first neutralizes every
configured executable content-filter driver. It then inspects only the paths
reported by the protected diff with `git check-attr --stdin -z filter`. An
active filter makes that working-tree operation fail explicitly; immutable
revision-to-revision comparisons remain available because they do not invoke
or approximate worktree conversion.

The parser also honours NUL-delimited rename/copy path forms. Results are associated with name-status records using normalized path or old/new path pairs without losing original display paths. A binary marker of `-` additions and `-` deletions is represented as binary, never as zero changes.

Totals are present only when meaningful. Missing or truncated statistics do not fabricate values.

## Native revision diffs

Revision content is loaded lazily with the equivalent of:

```text
git show <sha>:<path>
```

The provider uses resolved result SHAs, so an already opened diff cannot change when a branch moves.
Paths read from immutable trees are validated using Git's repository-relative
syntax rather than the current host's filename rules. Host-incompatible names
stay inside Git commands and signed virtual document URIs; any working-tree
side is promoted through the stricter host-specific boundary first.

| Change                | Left side                | Right side                  |
| --------------------- | ------------------------ | --------------------------- |
| added                 | empty document           | new path at `toSha`         |
| deleted               | old path at `fromSha`    | empty document              |
| renamed               | old path at `fromSha`    | new path at `toSha`         |
| copied                | source path at `fromSha` | destination path at `toSha` |
| modified/type changed | path at `fromSha`        | path at `toSha`             |

Text changes open through `vscode.diff` with preview enabled. Binary files never get decoded into a text document. They display `Binary file changed` and may expose `Open left revision` and `Open right revision` where those objects exist.

## Failure classification

Ref resolution distinguishes missing base from missing target. Missing objects may indicate deletion, shallow history, or repository corruption and are mapped to the most specific safe error available. Timeouts, cancellation, output limits, Git absence, repository absence, and unknown command failures remain distinct.

Raw stderr may inform redacted technical diagnostics but is never shown verbatim as the main user-facing error. A failed or invalid calculation never removes its saved comparison.

## Stash inspection and single-file creation

RefHaven reads existing stash commits using the same immutable-revision and
literal-path rules as commit inspection. It can list stashes, expand changed
files, open revisions and native comparisons, and search recent stash history.

**Stash This File...** accepts one changed tracked regular file. A detected
rename selects both its old and new paths so the rename is represented as one
operation. The input message is trimmed, must contain 1–500 characters, and is
used in the ordinary `On <branch>: <message>` stash subject. Confirming the
message saves a matching dirty VS Code document before the Git mutation begins;
a failed or incomplete save stops the operation.

For captured `HEAD` commit `H`, selected index state `I`, and selected
working-tree state `W`, RefHaven constructs the standard two-parent stash
shape:

```text
I-commit tree = H with only the selected path(s) replaced by I
stash tree    = H with only the selected path(s) replaced by W
stash parents = H, I-commit
```

This preserves separate staged and unstaged states, including partial staging,
and remains compatible with Git's ordinary stash inspection and
`git stash apply --index`. Every unselected entry in both trees is taken from
`H`; unrelated staged and working-tree changes are therefore absent from the
stash and remain untouched locally. There is no untracked third parent.

Publication and cleanup have distinct outcomes. RefHaven verifies `HEAD`, the
selected stage-zero index entries, and stable on-disk file fingerprints before
atomically updating `refs/stash` and a private recovery ref. The stash update
supplies the previously observed stash tip as the expected old value, so a concurrent stash publication fails without
changing the selected file. After successful publication, the stash remains a
valid result even if cleanup cannot safely finish.

Working-tree cleanup never performs an unconditional checkout or restore. The
captured path is atomically renamed into a same-filesystem Git metadata safety
directory and verified there. The `H` version is materialized beforehand and
installed with a hard link only while the destination name is absent. A
concurrent writer that recreates the destination wins; `EEXIST` stops cleanup
and the newer path is not removed or replaced. Deletions use the same
absence/no-clobber rule. RefHaven derives a clean full index from the captured
index, acquires the real `index.lock`, compares the live index byte for byte,
synchronizes the lock, and atomically renames it into place. A mismatch or busy
lock preserves newer index state.

Before path evacuation, RefHaven writes a durable phase journal under
`<absolute-git-dir>/refhaven-recovery/stash-*`. An incomplete post-publication
operation reports both the stash and recovery directory immediately. When an
existing file was evacuated, the completed journal and safety copy are also
retained: an editor holding the pre-rename file open may continue writing that
inode. RefHaven never automatically deletes these directories; removal is
manual only after closing possible writers and verifying the stash, visible
path, and index. Successful completion normally removes the private recovery
ref. If the journal retains a non-null `recoveryRef`, delete it using the
journal's `stashSha` as the expected old value before removing the directory.

The command fails closed before publication for clean or untracked paths,
conflicts, active `filter` attributes, sparse checkout, symlinks, gitlinks and
other non-regular entries, special/non-stage-zero index entries, content over
64 MiB, or a different filesystem device between the selected path and Git
recovery directory. Failure of a required rename or no-clobber hard link after
publication retains recovery state and reports incomplete cleanup. Git hooks
are disabled throughout stash construction and ref publication. RefHaven does
not expose apply, pop, drop, multi-file stash, include-untracked, or keep-index
commands.

## Browser URL semantics

Browser-link actions enumerate only locally configured remotes. With the default
empty origin list, HTTP(S) remotes supply their exact browser origin and SSH or
scp-style remotes infer HTTPS on the same hostname. A non-empty configured list
becomes a strict allowlist: HTTP remotes match the complete origin, including
the effective port, while SSH remotes match only the hostname and require an
explicit choice when several allowed browser origins share it.

The validated project, revision, comparison, and file target is rendered with
the selected GitHub, GitLab, Bitbucket, or Gitea-compatible URL grammar. Host
detection uses only the local remote hostname; an explicit grammar setting
handles self-hosted instances whose hostname is ambiguous.

Every symbolic reference is resolved locally to a full commit object ID before
URL construction. Comparison URLs therefore use `<baseSha>...<targetSha>`,
branch and tag actions use immutable tree URLs, and file URLs are emitted only
after `git ls-tree` confirms that the exact literal path is a blob at the
selected SHA. Project and file path segments are decoded once, validated, and
encoded again. The completed URL must still have the selected, policy-matched
origin before it is passed to `vscode.env.openExternal`.

RefHaven does not perform an HTTP request, follow redirects, read browser
credentials, or persist/log the resulting URL. Browser and server behavior
after the explicit handoff is outside the extension boundary.

## Required semantic fixtures

Integration tests create real temporary repositories for linear-ahead, linear-behind, divergent, rename, add/delete, binary, deleted ref, remote-tracking ref, unrelated roots, shallow clone, detached HEAD, worktree, and multi-root scenarios. Unit tests cover both count direction and all NUL parser edge cases, including path spaces, tabs, newlines, Unicode, malformed/truncated output, and unknown statuses.
