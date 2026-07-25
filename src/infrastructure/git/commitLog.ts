import type { CommitInfo } from "../../domain/comparisonResult";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

/** `git log --format` template matching {@link parseCommitLog}. */
export const COMMIT_LOG_FORMAT = "%H%x1f%an%x1f%at%x1f%s%x1e";

export class GitCommitLogParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitCommitLogParseError";
  }
}

/**
 * Parses `git log` output produced with {@link COMMIT_LOG_FORMAT}: records
 * separated by 0x1e, fields (sha, author, epoch seconds, subject) by 0x1f.
 */
export function parseCommitLog(stdout: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^\r?\n/, "");
    if (trimmed.length === 0) continue;

    const [sha, authorName, epochSeconds, subject] = trimmed.split(FIELD_SEPARATOR);
    if (sha === undefined || authorName === undefined || epochSeconds === undefined) {
      throw new GitCommitLogParseError("Malformed Git commit log record.");
    }
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
      throw new GitCommitLogParseError(`Invalid commit SHA in Git log output: ${sha}.`);
    }
    const authorDateSeconds = Number.parseInt(epochSeconds, 10);
    if (Number.isNaN(authorDateSeconds)) {
      throw new GitCommitLogParseError(`Invalid commit date in Git log output: ${epochSeconds}.`);
    }

    commits.push({
      authorDate: authorDateSeconds * 1000,
      authorName,
      sha,
      subject: subject ?? "",
    });
  }
  return commits;
}
