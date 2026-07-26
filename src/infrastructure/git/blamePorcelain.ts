import type { FileBlameLine, LineBlame } from "../../domain/blame";
import { isGitObjectId } from "../../domain/gitObjectId";
import { parseGitEpochSeconds } from "./gitTimestamp";

const HEADER_PATTERN = /^(\S+) (\d+) (\d+)(?: \d+)?$/u;

export class GitBlameParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitBlameParseError";
  }
}

/** Parses one-line `git blame --porcelain -L n,n` output. */
export function parseBlamePorcelain(stdout: string): LineBlame | null {
  const records = parseBlameFilePorcelain(stdout);
  return records[0]?.blame ?? null;
}

/** Parses repeated records from `git blame --line-porcelain`. */
export function parseBlameFilePorcelain(stdout: string): FileBlameLine[] {
  if (stdout.length === 0) return [];
  const lines = stdout.split(/\r?\n/u);
  const records: FileBlameLine[] = [];
  const seenLines = new Set<number>();
  let index = 0;

  while (index < lines.length) {
    const header = lines[index];
    if (header === undefined || header.length === 0) break;
    const match = HEADER_PATTERN.exec(header);
    const sha = match?.[1];
    const originalLineText = match?.[2];
    const finalLineText = match?.[3];
    if (!sha || !isGitObjectId(sha) || !originalLineText || !finalLineText) {
      throw new GitBlameParseError("Malformed Git blame header.");
    }
    const originalLineNumber = Number.parseInt(originalLineText, 10);
    const lineNumber = Number.parseInt(finalLineText, 10);
    if (
      !Number.isSafeInteger(originalLineNumber) ||
      originalLineNumber < 1 ||
      !Number.isSafeInteger(lineNumber) ||
      lineNumber < 1 ||
      seenLines.has(lineNumber)
    ) {
      throw new GitBlameParseError("Invalid final line number in Git blame output.");
    }
    index += 1;

    const metadata = new Map<string, string>();
    let foundContent = false;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined) break;
      if (line.startsWith("\t")) {
        foundContent = true;
        index += 1;
        break;
      }
      const separatorIndex = line.indexOf(" ");
      if (separatorIndex === -1) metadata.set(line, "");
      else metadata.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
      index += 1;
    }
    if (!foundContent) throw new GitBlameParseError("Git blame output is missing line content.");

    records.push({
      blame: parseMetadata(sha, originalLineNumber, lineNumber, metadata),
      lineNumber,
    });
    seenLines.add(lineNumber);
  }

  return records.sort((left, right) => left.lineNumber - right.lineNumber);
}

function parseMetadata(
  sha: string,
  originalLineNumber: number,
  finalLineNumber: number,
  metadata: ReadonlyMap<string, string>,
): LineBlame {
  const authorName = metadata.get("author");
  const authorTime = metadata.get("author-time");
  const path = metadata.get("filename");
  if (authorName === undefined || authorTime === undefined || path === undefined) {
    throw new GitBlameParseError("Git blame output is missing required fields.");
  }
  const authorDateSeconds = parseGitEpochSeconds(authorTime);
  if (authorDateSeconds === null)
    throw new GitBlameParseError("Git blame output contains an invalid author time.");

  const isCommitted = !/^0+$/u.test(sha);
  const previous = parsePrevious(metadata.get("previous"));
  const authorMail = metadata.get("author-mail");
  const authorTimeZone = metadata.get("author-tz");
  return {
    authorDate: authorDateSeconds * 1000,
    ...(authorMail ? { authorEmail: authorMail.replace(/^<|>$/gu, "") } : {}),
    authorName,
    ...(authorTimeZone ? { authorTimeZone } : {}),
    finalLineNumber,
    isCommitted,
    originalLineNumber,
    path,
    ...previous,
    sha,
    summary: isCommitted ? (metadata.get("summary") ?? "") : "",
  };
}

function parsePrevious(value: string | undefined): {
  readonly previousPath?: string;
  readonly previousSha?: string;
} {
  if (!value) return {};
  const separator = value.indexOf(" ");
  if (separator < 1 || separator === value.length - 1) {
    throw new GitBlameParseError("Git blame output contains an invalid previous revision.");
  }
  const previousSha = value.slice(0, separator);
  if (!isGitObjectId(previousSha)) {
    throw new GitBlameParseError("Git blame output contains an invalid previous revision.");
  }
  return { previousPath: value.slice(separator + 1), previousSha };
}
