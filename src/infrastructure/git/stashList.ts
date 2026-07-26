import type { StashEntry } from "../../domain/stash";
import { isGitObjectId } from "../../domain/gitObjectId";
import { parseGitEpochSeconds } from "./gitTimestamp";

const FIELD_SEPARATOR = "\0";
const SELECTOR_PATTERN = /^stash@\{\d+\}$/;

/** `git stash list --format` template matching {@link parseStashList}. */
export const STASH_LOG_FORMAT = "%gd%x00%H%x00%P%x00%at%x00%gs%x00";

export class GitStashListParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitStashListParseError";
  }
}

/**
 * Parses `git stash list` output produced with {@link STASH_LOG_FORMAT}.
 * NUL safely separates fields because Git metadata cannot contain it.
 */
export function parseStashList(stdout: string): StashEntry[] {
  const stashes: StashEntry[] = [];
  const fields = stdout.split(FIELD_SEPARATOR);
  for (let index = 0; index < fields.length;) {
    const selector = fields[index++]?.replace(/^\r?\n/u, "");
    if (selector === "" && index === fields.length) break;
    const sha = fields[index++];
    const parents = fields[index++];
    const epochSeconds = fields[index++];
    const subject = fields[index++];
    if (
      !selector ||
      sha === undefined ||
      parents === undefined ||
      epochSeconds === undefined ||
      subject === undefined
    ) {
      throw new GitStashListParseError("Malformed Git stash list record.");
    }
    if (!SELECTOR_PATTERN.test(selector)) {
      throw new GitStashListParseError("Git returned an invalid stash selector.");
    }
    if (!isGitObjectId(sha)) {
      throw new GitStashListParseError("Git returned an invalid stash SHA.");
    }
    const parentSha = parents.split(" ")[0];
    if (parentSha === undefined || !isGitObjectId(parentSha)) {
      throw new GitStashListParseError("Git returned an invalid stash parent.");
    }
    const authorDateSeconds = parseGitEpochSeconds(epochSeconds);
    if (authorDateSeconds === null)
      throw new GitStashListParseError("Git returned an invalid stash date.");

    stashes.push({
      authorDate: authorDateSeconds * 1000,
      ...parseStashSubject(subject),
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
