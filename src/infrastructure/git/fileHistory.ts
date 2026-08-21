import type { FileHistoryEntry, LineHistoryEntry } from "../../domain/history";
import type { FileChange } from "../../domain/comparisonResult";
import { isGitObjectId } from "../../domain/gitObjectId";
import { parseChangedLineRanges } from "./diffHunks";
import { parseGitEpochSeconds } from "./gitTimestamp";
import { nameStatusPathCount, parseNameStatusZ } from "./nameStatus";

const FIELD_SEPARATOR = "\0";

/** `git log --name-status -z --format` template matching {@link parseFileHistory}. */
export const FILE_HISTORY_LOG_FORMAT = "%H%x00%P%x00%an%x00%at%x00%s%x00";
/** Leading NUL separates each metadata record from its following `git log -L` patch. */
export const LINE_HISTORY_LOG_FORMAT = "%x00%H%x00%P%x00%an%x00%at%x00%s%x00";

export class GitFileHistoryParseError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitFileHistoryParseError";
  }
}

/** Parses fixed metadata followed by exactly one validated name-status change per commit. */
export function parseFileHistory(stdout: string): FileHistoryEntry[] {
  const entries: FileHistoryEntry[] = [];
  const fields = stdout.split(FIELD_SEPARATOR);
  for (let index = 0; index < fields.length;) {
    const sha = fields[index++]?.replace(/^\r?\n/u, "");
    if (sha === "" && index === fields.length) break;
    const parents = fields[index++];
    const authorName = fields[index++];
    const epochSeconds = fields[index++];
    const subject = fields[index++];
    if (
      !sha ||
      parents === undefined ||
      authorName === undefined ||
      epochSeconds === undefined ||
      subject === undefined ||
      !isGitObjectId(sha)
    ) {
      throw new GitFileHistoryParseError("Malformed file history metadata.");
    }
    const authorDateSeconds = parseGitEpochSeconds(epochSeconds);
    if (authorDateSeconds === null) {
      throw new GitFileHistoryParseError("Invalid file history timestamp.");
    }
    const firstParent = parents.split(" ")[0] ?? "";
    const parentSha = firstParent === "" ? null : firstParent;
    if (parentSha !== null && !isGitObjectId(parentSha)) {
      throw new GitFileHistoryParseError("Invalid file history parent.");
    }
    const recordSeparator = fields[index++];
    const status = fields[index++]?.replace(/^\r?\n/u, "");
    if (recordSeparator !== "" || !status) {
      throw new GitFileHistoryParseError("Malformed file history change data.");
    }
    const statusFields = [status];
    let pathCount: number;
    try {
      pathCount = nameStatusPathCount(status);
    } catch (error) {
      throw new GitFileHistoryParseError("Malformed file history change data.", { cause: error });
    }
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      const path = fields[index++];
      if (path === undefined) {
        throw new GitFileHistoryParseError("Malformed file history change data.");
      }
      statusFields.push(path);
    }
    let changes: FileChange[];
    try {
      changes = parseNameStatusZ(`${statusFields.join("\0")}\0`);
    } catch (error) {
      throw new GitFileHistoryParseError("Malformed file history change data.", { cause: error });
    }
    const change = changes[0];
    if (!change || changes.length !== 1) {
      throw new GitFileHistoryParseError("Expected one changed path per file history entry.");
    }
    entries.push({
      change,
      commit: {
        authorDate: authorDateSeconds * 1000,
        authorName,
        sha,
        subject,
      },
      parentSha,
    });
  }
  return entries;
}

/** Parses NUL-delimited line-history metadata and its exact tracked-line hunks. */
export function parseLineHistory(stdout: string): LineHistoryEntry[] {
  if (stdout === "") return [];
  const fields = stdout.split(FIELD_SEPARATOR);
  if (fields[0] !== "") {
    throw new GitFileHistoryParseError("Malformed line history record boundary.");
  }
  const entries: LineHistoryEntry[] = [];
  for (let index = 1; index < fields.length;) {
    const sha = fields[index++];
    const parents = fields[index++];
    const authorName = fields[index++];
    const epochSeconds = fields[index++];
    const subject = fields[index++];
    const patch = fields[index++];
    if (
      !sha ||
      parents === undefined ||
      authorName === undefined ||
      epochSeconds === undefined ||
      subject === undefined ||
      patch === undefined ||
      !isGitObjectId(sha)
    ) {
      throw new GitFileHistoryParseError("Malformed line history metadata.");
    }
    const authorDateSeconds = parseGitEpochSeconds(epochSeconds);
    if (authorDateSeconds === null) {
      throw new GitFileHistoryParseError("Invalid line history timestamp.");
    }
    const firstParent = parents.split(" ")[0] ?? "";
    const parentSha = firstParent === "" ? null : firstParent;
    if (parentSha !== null && !isGitObjectId(parentSha)) {
      throw new GitFileHistoryParseError("Invalid line history parent.");
    }
    let lineChanges: LineHistoryEntry["lineChanges"];
    try {
      lineChanges = parseChangedLineRanges(patch);
    } catch (error) {
      throw new GitFileHistoryParseError("Malformed line history patch.", { cause: error });
    }
    if (lineChanges.length === 0) {
      throw new GitFileHistoryParseError("Line history entry has no tracked-line hunk.");
    }
    entries.push({
      commit: {
        authorDate: authorDateSeconds * 1000,
        authorName,
        sha,
        subject,
      },
      lineChanges,
      parentSha,
    });
  }
  return entries;
}
