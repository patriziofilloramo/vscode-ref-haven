import type { LineBlame } from "../../domain/blame";
import { shortSha, type CommitInfo } from "../../domain/comparisonResult";
import { COMMAND_IDS } from "../commands/commandIds";
import { formatRelativeTime } from "../format";
import { encodeCommandArguments, escapeMarkdown } from "../markdown";

/** Commands that blame hover links may execute; used for MarkdownString trust. */
export const BLAME_HOVER_COMMANDS: readonly string[] = [
  COMMAND_IDS.copyCommitMessage,
  COMMAND_IDS.copyCommitSha,
  COMMAND_IDS.openFileAtRevision,
  COMMAND_IDS.openGitLabFile,
];

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
  const author = blameAuthorLabel(blame, currentUserName);
  if (!blame.isCommitted) return `${author} · Uncommitted changes`;
  const summary = blame.summary.length > 0 ? ` · ${blame.summary}` : "";
  return `${author}, ${formatRelativeTime(blame.authorDate, nowMs)}${summary}`;
}

export function statusBarBlameText(
  blame: LineBlame,
  currentUserName: string | null,
  nowMs: number,
): string {
  const author = blameAuthorLabel(blame, currentUserName);
  if (!blame.isCommitted) return `$(git-commit) ${author}, uncommitted`;
  return `$(git-commit) ${author}, ${formatRelativeTime(blame.authorDate, nowMs)}`;
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
      `[Open on GitLab](command:${COMMAND_IDS.openGitLabFile}?${gitLabArguments})`,
    ].join(" · "),
  ].join("\n\n");
}
