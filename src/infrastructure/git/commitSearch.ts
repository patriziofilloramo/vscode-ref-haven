import type { CommitSearchQuery } from "../../domain/commitDetails";

export const MAX_COMMIT_SEARCH_TEXT_LENGTH = 512;

/**
 * Builds only the query-specific part of a bounded local `git log` search.
 * Message and author searches expose explicit literal/regex and case semantics;
 * content searches use Git's `-G` added/removed-line semantics and are
 * necessarily case-sensitive.
 */
export function buildCommitSearchCriteria(query: CommitSearchQuery): string[] {
  assertValidCommitSearchQuery(query);
  if (query.kind === "sha") return [];

  if (query.kind === "content") {
    const pattern =
      query.patternMode === "literal" ? escapeExtendedRegularExpression(query.text) : query.text;
    return [`-G${pattern}`, "--pickaxe-all"];
  }

  const caseArguments = query.caseSensitive ? [] : ["--regexp-ignore-case"];
  if (query.kind === "message") {
    return [
      query.patternMode === "literal" ? "--fixed-strings" : "--extended-regexp",
      ...caseArguments,
      `--grep=${query.text}`,
    ];
  }

  const pattern =
    query.patternMode === "literal" ? escapeExtendedRegularExpression(query.text) : query.text;
  return ["--extended-regexp", ...caseArguments, `--author=${pattern}`];
}

export function assertValidCommitSearchQuery(query: CommitSearchQuery): void {
  if (
    query.text.length === 0 ||
    query.text.length > MAX_COMMIT_SEARCH_TEXT_LENGTH ||
    query.text.includes("\0")
  ) {
    throw new Error("The commit search query is invalid.");
  }
  if (query.kind === "sha" && !/^[0-9a-f]{4,64}$/iu.test(query.text)) {
    throw new Error("The commit SHA prefix is invalid.");
  }
}

function escapeExtendedRegularExpression(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}
