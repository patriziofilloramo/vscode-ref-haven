import type { StashEntry } from "../../domain/stash";
import { isGitObjectId } from "../../domain/gitObjectId";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const SELECTOR_PATTERN = /^stash@\{\d+\}$/;

/** `git stash list --format` template matching {@link parseStashList}. */
export const STASH_LOG_FORMAT = "%gd%x1f%H%x1f%P%x1f%at%x1f%gs%x1e";

export class GitStashListParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitStashListParseError";
  }
}

/**
 * Parses `git stash list` output produced with {@link STASH_LOG_FORMAT}:
 * records separated by 0x1e, fields (selector, sha, parent shas, epoch
 * seconds, reflog subject) by 0x1f.
 */
export function parseStashList(stdout: string): StashEntry[] {
  const stashes: StashEntry[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^\r?\n/, "");
    if (trimmed.length === 0) continue;

    const [selector, sha, parents, epochSeconds, subject] = trimmed.split(FIELD_SEPARATOR);
    if (
      selector === undefined ||
      sha === undefined ||
      parents === undefined ||
      epochSeconds === undefined
    ) {
      throw new GitStashListParseError("Malformed Git stash list record.");
    }
    if (!SELECTOR_PATTERN.test(selector)) {
      throw new GitStashListParseError(`Invalid stash selector in Git output: ${selector}.`);
    }
    if (!isGitObjectId(sha)) {
      throw new GitStashListParseError(`Invalid stash SHA in Git output: ${sha}.`);
    }
    const parentSha = parents.split(" ")[0];
    if (parentSha === undefined || !isGitObjectId(parentSha)) {
      throw new GitStashListParseError(`Invalid stash parent in Git output: ${parents}.`);
    }
    const authorDateSeconds = Number.parseInt(epochSeconds, 10);
    if (Number.isNaN(authorDateSeconds)) {
      throw new GitStashListParseError(`Invalid stash date in Git output: ${epochSeconds}.`);
    }

    stashes.push({
      authorDate: authorDateSeconds * 1000,
      ...parseStashSubject(subject ?? ""),
      parentSha,
      selector,
      sha,
    });
  }
  return stashes;
}

/**
 * Splits a stash reflog subject such as `WIP on main: abc1234 commit subject`
 * or `On feature/x: custom message` into the branch and the human message.
 */
function parseStashSubject(subject: string): {
  readonly branchName?: string;
  readonly message: string;
} {
  const match = /^(?:WIP on|On) ([^:]+): ?(.*)$/.exec(subject);
  const branchName = match?.[1];
  const message = match?.[2];
  if (branchName === undefined) return { message: subject };
  return {
    ...(branchName === "(no branch)" ? {} : { branchName }),
    message: message !== undefined && message.length > 0 ? message : subject,
  };
}
