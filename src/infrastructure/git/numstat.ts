import type { FileChange } from "../../domain/comparisonResult";

export class GitNumstatParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitNumstatParseError";
  }
}

export interface NumstatEntry {
  /** Undefined when the change is binary. */
  readonly additions?: number;
  /** Undefined when the change is binary. */
  readonly deletions?: number;
  readonly newPath: string;
  readonly oldPath?: string;
}

/**
 * Parses `git diff --numstat -z` output. Records are NUL-delimited; a record
 * whose path portion is empty is followed by two extra NUL-delimited fields
 * carrying the old and new path of a rename or copy.
 */
export function parseNumstatZ(stdout: string): NumstatEntry[] {
  if (stdout.length === 0) return [];

  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();

  const entries: NumstatEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (record === undefined) break;

    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (!match) throw new GitNumstatParseError("Git returned a malformed numstat record.");

    const additions = match[1] === "-" ? undefined : Number.parseInt(match[1] ?? "", 10);
    const deletions = match[2] === "-" ? undefined : Number.parseInt(match[2] ?? "", 10);
    const inlinePath = match[3] ?? "";

    if (inlinePath.length > 0) {
      entries.push({
        ...(additions === undefined ? {} : { additions }),
        ...(deletions === undefined ? {} : { deletions }),
        newPath: inlinePath,
      });
      continue;
    }

    const oldPath = fields[index++];
    const newPath = fields[index++];
    if (!oldPath || !newPath) {
      throw new GitNumstatParseError("Missing rename paths in Git numstat output.");
    }
    entries.push({
      ...(additions === undefined ? {} : { additions }),
      ...(deletions === undefined ? {} : { deletions }),
      newPath,
      oldPath,
    });
  }

  return entries;
}

/** Attaches per-file addition/deletion counts to name-status changes. */
export function mergeChangesWithStats(
  changes: readonly FileChange[],
  stats: readonly NumstatEntry[],
): FileChange[] {
  const statsByNewPath = new Map(stats.map((entry) => [entry.newPath, entry]));
  return changes.map((change) => {
    const entry = statsByNewPath.get(change.newPath);
    if (!entry) return change;
    return {
      ...change,
      ...(entry.additions === undefined ? {} : { additions: entry.additions }),
      ...(entry.deletions === undefined ? {} : { deletions: entry.deletions }),
    };
  });
}
