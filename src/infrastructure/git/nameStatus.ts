import type { FileChange, FileChangeStatus } from "../../domain/comparisonResult";

export class GitNameStatusParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitNameStatusParseError";
  }
}

export function parseNameStatusZ(stdout: string): FileChange[] {
  if (stdout.length === 0) return [];

  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();

  const changes: FileChange[] = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    if (!rawStatus) throw new GitNameStatusParseError("Missing Git file status.");

    const { similarity, status, usesTwoPaths } = parseStatus(rawStatus);
    const firstPath = fields[index++];
    if (firstPath === undefined || firstPath.length === 0) {
      throw new GitNameStatusParseError(`Missing path for Git status ${rawStatus}.`);
    }

    if (usesTwoPaths) {
      const secondPath = fields[index++];
      if (secondPath === undefined || secondPath.length === 0) {
        throw new GitNameStatusParseError(`Missing destination path for Git status ${rawStatus}.`);
      }
      changes.push({
        newPath: secondPath,
        oldPath: firstPath,
        ...(similarity === undefined ? {} : { similarity }),
        status,
      });
      continue;
    }

    changes.push({ newPath: firstPath, status });
  }

  return changes;
}

function parseStatus(rawStatus: string): {
  readonly similarity?: number;
  readonly status: FileChangeStatus;
  readonly usesTwoPaths: boolean;
} {
  if (/^(U|DD|AU|UD|UA|DU|AA|UU)$/.test(rawStatus)) {
    return { status: "unmerged", usesTwoPaths: false };
  }

  const match = /^([AMDTCR])(\d{1,3})?$/.exec(rawStatus);
  if (!match) throw new GitNameStatusParseError(`Unsupported Git file status: ${rawStatus}.`);

  const code = match[1];
  const scoreText = match[2];
  const similarity = scoreText === undefined ? undefined : Number.parseInt(scoreText, 10);
  if (similarity !== undefined && code !== "R" && code !== "C") {
    throw new GitNameStatusParseError(`Unexpected Git similarity score: ${rawStatus}.`);
  }
  if (similarity !== undefined && similarity > 100) {
    throw new GitNameStatusParseError(`Invalid Git similarity score: ${rawStatus}.`);
  }

  const statusByCode: Readonly<Record<string, FileChangeStatus>> = {
    A: "added",
    C: "copied",
    D: "deleted",
    M: "modified",
    R: "renamed",
    T: "typeChanged",
  };
  const status = code ? statusByCode[code] : undefined;
  if (!status) throw new GitNameStatusParseError(`Unsupported Git file status: ${rawStatus}.`);

  return {
    ...(similarity === undefined ? {} : { similarity }),
    status,
    usesTwoPaths: code === "R" || code === "C",
  };
}
