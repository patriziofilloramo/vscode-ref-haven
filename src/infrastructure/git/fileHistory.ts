import type { FileHistoryEntry } from "../../domain/history";
import type { FileChange } from "../../domain/comparisonResult";
import { parseNameStatusZ } from "./nameStatus";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

export const FILE_HISTORY_LOG_FORMAT = "%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s";

export class GitFileHistoryParseError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitFileHistoryParseError";
  }
}

export function parseFileHistory(stdout: string): FileHistoryEntry[] {
  const entries: FileHistoryEntry[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    if (record.length === 0) continue;
    const fields = record.split("\0");
    const metadata = fields.shift();
    if (!metadata) continue;
    const [sha, parents, authorName, epochSeconds, subject] = metadata.split(FIELD_SEPARATOR);
    if (
      sha === undefined ||
      parents === undefined ||
      authorName === undefined ||
      epochSeconds === undefined ||
      !/^[0-9a-f]{40,64}$/iu.test(sha)
    ) {
      throw new GitFileHistoryParseError("Malformed file history metadata.");
    }
    const authorDateSeconds = Number.parseInt(epochSeconds, 10);
    if (!Number.isFinite(authorDateSeconds)) {
      throw new GitFileHistoryParseError("Invalid file history timestamp.");
    }
    const firstParent = parents.split(" ")[0] ?? "";
    const parentSha = firstParent === "" ? null : firstParent;
    if (parentSha !== null && !/^[0-9a-f]{40,64}$/iu.test(parentSha)) {
      throw new GitFileHistoryParseError("Invalid file history parent.");
    }
    const statusFields = fields.filter((field) => field.length > 0);
    if (statusFields[0] !== undefined) {
      statusFields[0] = statusFields[0].replace(/^\r?\n/u, "");
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
        subject: subject ?? "",
      },
      parentSha,
    });
  }
  return entries;
}
