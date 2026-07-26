import type { CommitInfo } from "../../domain/comparisonResult";
import { isGitObjectId } from "../../domain/gitObjectId";
import { parseGitEpochSeconds } from "./gitTimestamp";

const FIELD_SEPARATOR = "\0";

/** `git log --format` template matching {@link parseCommitLog}. */
export const COMMIT_LOG_FORMAT = "%H%x00%an%x00%at%x00%s%x00";

export class GitCommitLogParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitCommitLogParseError";
  }
}

/**
 * Parses `git log` output produced with {@link COMMIT_LOG_FORMAT}. NUL safely
 * separates fields because Git identities and commit messages cannot contain it.
 */
export function parseCommitLog(stdout: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  const fields = stdout.split(FIELD_SEPARATOR);
  for (let index = 0; index < fields.length;) {
    const sha = fields[index++]?.replace(/^\r?\n/u, "");
    if (sha === "" && index === fields.length) break;
    const authorName = fields[index++];
    const epochSeconds = fields[index++];
    const subject = fields[index++];
    if (!sha || authorName === undefined || epochSeconds === undefined || subject === undefined) {
      throw new GitCommitLogParseError("Malformed Git commit log record.");
    }
    if (!isGitObjectId(sha)) {
      throw new GitCommitLogParseError("Git returned an invalid commit SHA.");
    }
    const authorDateSeconds = parseGitEpochSeconds(epochSeconds);
    if (authorDateSeconds === null)
      throw new GitCommitLogParseError("Git returned an invalid commit date.");

    commits.push({
      authorDate: authorDateSeconds * 1000,
      authorName,
      sha,
      subject,
    });
  }
  return commits;
}
