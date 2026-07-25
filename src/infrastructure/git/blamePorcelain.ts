import type { LineBlame } from "../../domain/blame";

const HEADER_PATTERN = /^([0-9a-f]{40,64}) \d+ \d+( \d+)?$/;

export class GitBlameParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitBlameParseError";
  }
}

/**
 * Parses `git blame --porcelain -L n,n` output for a single line: a header
 * (`<sha> <origLine> <finalLine> <numLines>`), `key value` metadata lines, and
 * the tab-prefixed line content. Returns null for empty output.
 */
export function parseBlamePorcelain(stdout: string): LineBlame | null {
  const lines = stdout.split(/\r?\n/);
  const header = lines[0];
  if (header === undefined || header.length === 0) return null;

  const headerMatch = HEADER_PATTERN.exec(header);
  const sha = headerMatch?.[1];
  if (sha === undefined) {
    throw new GitBlameParseError("Malformed Git blame header.");
  }

  const metadata = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.startsWith("\t")) break;
    const separatorIndex = line.indexOf(" ");
    if (separatorIndex === -1) {
      metadata.set(line, "");
      continue;
    }
    metadata.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
  }

  const authorName = metadata.get("author");
  const authorTime = metadata.get("author-time");
  const path = metadata.get("filename");
  if (authorName === undefined || authorTime === undefined || path === undefined) {
    throw new GitBlameParseError("Git blame output is missing required fields.");
  }
  const authorDateSeconds = Number.parseInt(authorTime, 10);
  if (Number.isNaN(authorDateSeconds)) {
    throw new GitBlameParseError(`Invalid author time in Git blame output: ${authorTime}.`);
  }

  const isCommitted = !/^0+$/.test(sha);
  return {
    authorDate: authorDateSeconds * 1000,
    authorName,
    isCommitted,
    path,
    sha,
    summary: isCommitted ? (metadata.get("summary") ?? "") : "",
  };
}
