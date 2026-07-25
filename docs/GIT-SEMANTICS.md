# Git semantics

This document is normative. Command ranges or result direction must not change without corresponding tests, documentation updates, and an ADR when the change affects a protected design decision.

For every example:

```text
baseRef   = refs/heads/main
targetRef = refs/heads/feature/oauth
```

The extension passes arguments directly to Git without a shell. Before calculation it resolves both selected symbolic refs to immutable commit SHAs. Saved comparisons retain symbolic refs; calculated results and revision documents use SHAs.

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
git diff --name-status -z --find-renames <fromSha> <toSha> --
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

## Numstat

Statistics are obtained separately:

```text
git diff --numstat -z --find-renames <fromSha> <toSha> --
```

The parser also honours NUL-delimited rename/copy path forms. Results are associated with name-status records using normalized path or old/new path pairs without losing original display paths. A binary marker of `-` additions and `-` deletions is represented as binary, never as zero changes.

Totals are present only when meaningful. Missing or truncated statistics do not fabricate values.

## Native revision diffs

Revision content is loaded lazily with the equivalent of:

```text
git show <sha>:<path>
```

The provider uses resolved result SHAs, so an already opened diff cannot change when a branch moves.

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

## Required semantic fixtures

Integration tests create real temporary repositories for linear-ahead, linear-behind, divergent, rename, add/delete, binary, deleted ref, remote-tracking ref, unrelated roots, shallow clone, detached HEAD, worktree, and multi-root scenarios. Unit tests cover both count direction and all NUL parser edge cases, including path spaces, tabs, newlines, Unicode, malformed/truncated output, and unknown statuses.
