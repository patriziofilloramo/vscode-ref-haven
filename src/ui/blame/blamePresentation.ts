import type { LineBlame } from "../../domain/blame";
import type { FileBlameFormat } from "../../domain/fileAnnotations";
import { shortSha, type CommitInfo } from "../../domain/comparisonResult";
import { COMMAND_IDS } from "../commands/commandIds";
import { formatRelativeTime } from "../format";
import { encodeCommandArguments, escapeMarkdown } from "../markdown";

/** Commands that blame hover links may execute; used for MarkdownString trust. */
export const BLAME_HOVER_COMMANDS: readonly string[] = [
  COMMAND_IDS.copyCommitMessage,
  COMMAND_IDS.copyCommitSha,
  COMMAND_IDS.openFileAtRevision,
  COMMAND_IDS.openBrowserFile,
];

const MAX_BLAME_AUTHOR_LENGTH = 40;
const MAX_BLAME_SUMMARY_LENGTH = 80;

export function blameCommitInfo(blame: LineBlame): CommitInfo {
  return {
    authorDate: blame.authorDate,
    authorName: blame.authorName,
    sha: blame.sha,
    subject: blame.summary,
  };
}

/** Replaces the author with `You` when it matches the configured Git user. */
export function blameAuthorLabel(blame: LineBlame, currentUserName: string | null): string {
  if (!blame.isCommitted) return "You";
  return currentUserName !== null && blame.authorName === currentUserName
    ? "You"
    : blame.authorName;
}

/** Dimmed authorship text appended to the current editor line. */
export function inlineBlameText(
  blame: LineBlame,
  currentUserName: string | null,
  nowMs: number,
): string {
  const author = truncateSingleLine(
    blameAuthorLabel(blame, currentUserName),
    MAX_BLAME_AUTHOR_LENGTH,
  );
  if (!blame.isCommitted) return `${author} · Uncommitted changes`;
  const summary = truncateSingleLine(blame.summary, MAX_BLAME_SUMMARY_LENGTH);
  return `${author}, ${formatRelativeTime(blame.authorDate, nowMs)}${summary ? ` · ${summary}` : ""}`;
}

/** Bounded authorship text used by whole-file blame decorations. */
export function fileBlameAnnotationText(
  blame: LineBlame,
  currentUserName: string | null,
  nowMs: number,
  format: FileBlameFormat,
): string {
  const author = truncateSingleLine(
    blameAuthorLabel(blame, currentUserName),
    MAX_BLAME_AUTHOR_LENGTH,
  );
  if (!blame.isCommitted) return `${author} \u00b7 Uncommitted changes`;

  const attribution = `${author}, ${formatRelativeTime(blame.authorDate, nowMs)}`;
  if (format === "compact") return attribution;
  const summary = truncateSingleLine(blame.summary, MAX_BLAME_SUMMARY_LENGTH);
  return summary.length > 0 ? `${attribution} \u00b7 ${summary}` : attribution;
}

export function statusBarBlameText(
  blame: LineBlame,
  currentUserName: string | null,
  nowMs: number,
): string {
  const author = truncateSingleLine(
    blameAuthorLabel(blame, currentUserName),
    MAX_BLAME_AUTHOR_LENGTH,
  );
  if (!blame.isCommitted) return `$(git-commit) ${author} · uncommitted`;
  return `$(git-commit) ${author} · ${formatRelativeTime(blame.authorDate, nowMs)}`;
}

/**
 * Markdown body for the blame hover. Command links require the rendering
 * MarkdownString to trust {@link BLAME_HOVER_COMMANDS}.
 */
export function blameHoverMarkdown(
  blame: LineBlame,
  currentUserName: string | null,
  repositoryRootPath: string,
  nowMs: number,
): string {
  const author = escapeMarkdown(blameAuthorLabel(blame, currentUserName));
  if (!blame.isCommitted) {
    return `**${author}** · Uncommitted changes`;
  }

  const commitArguments = encodeCommandArguments([
    { commit: blameCommitInfo(blame), kind: "commit" },
  ]);
  const revisionArguments = encodeCommandArguments([repositoryRootPath, blame.sha, blame.path]);
  const gitLabArguments = encodeCommandArguments([
    repositoryRootPath,
    blame.sha,
    blame.path,
    ...(blame.originalLineNumber === undefined ? [] : [blame.originalLineNumber]),
  ]);
  return [
    `**${author}**, ${formatRelativeTime(blame.authorDate, nowMs)} (${new Date(blame.authorDate).toLocaleString()})`,
    escapeMarkdown(blame.summary),
    `$(git-commit) \`${shortSha(blame.sha)}\``,
    [
      `[Copy SHA](command:${COMMAND_IDS.copyCommitSha}?${commitArguments})`,
      `[Copy Message](command:${COMMAND_IDS.copyCommitMessage}?${commitArguments})`,
      `[Open File at This Revision](command:${COMMAND_IDS.openFileAtRevision}?${revisionArguments})`,
      `[Open in Browser](command:${COMMAND_IDS.openBrowserFile}?${gitLabArguments})`,
    ].join(" · "),
  ].join("\n\n");
}

function truncateSingleLine(value: string, maximumLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, maximumLength - 1).trimEnd()}\u2026`;
}
