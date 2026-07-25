import type { RichLineHover } from "../../domain/blame";
import { shortSha } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import { COMMAND_IDS } from "../commands/commandIds";
import { formatDiffStats, formatRelativeTime, pluralize } from "../format";
import { escapeMarkdown } from "../markdown";
import { blameAuthorLabel, blameCommitInfo } from "./blamePresentation";

const MAX_PREVIEW_CHARACTERS = 4_000;
const MAX_PREVIEW_LINES = 24;

export const RICH_BLAME_HOVER_COMMANDS: readonly string[] = [
  COMMAND_IDS.compareFileWithRevision,
  COMMAND_IDS.copyCommitMessage,
  COMMAND_IDS.copyCommitSha,
  COMMAND_IDS.openFileAtRevision,
  COMMAND_IDS.openGitLabFile,
  COMMAND_IDS.openLineDiff,
  COMMAND_IDS.showCommitDetails,
  COMMAND_IDS.showFileHistory,
  COMMAND_IDS.showLineHistory,
];

export function richBlameHoverMarkdown(data: RichLineHover, nowMs = Date.now()): string {
  const { blame } = data;
  const author = escapeMarkdown(blameAuthorLabel(blame, data.userName));
  if (!blame.isCommitted) {
    return `**${author}** · Uncommitted changes`;
  }

  const details = data.commitDetails;
  const commit = blameCommitInfo(blame);
  const commitNode = { commit, kind: "commit", repositoryRoot: data.repositoryRoot };
  const lines = [
    `**${author}**${details?.authorEmail ? ` <${escapeMarkdown(details.authorEmail)}>` : ""}`,
    `${formatRelativeTime(blame.authorDate, nowMs)} · ${new Date(blame.authorDate).toLocaleString()}${blame.authorTimeZone ? ` · Git timezone \`${escapeMarkdown(blame.authorTimeZone)}\`` : ""}`,
    `**${escapeMarkdown(blame.summary || "(no commit message)")}**`,
    `$(git-commit) \`${blame.sha}\``,
  ];

  const location = originalLocation(data);
  if (location) lines.push(`$(symbol-file) ${location}`);
  if (data.changedFileCount !== undefined) {
    const change = data.fileChange;
    const stats =
      change && (change.additions !== undefined || change.deletions !== undefined)
        ? ` · ${formatDiffStats(change.additions ?? 0, change.deletions ?? 0)} in this file`
        : "";
    lines.push(`$(files) ${pluralize(data.changedFileCount, "changed file")}${stats}`);
  }
  if (
    details &&
    (details.committerName !== details.commit.authorName ||
      details.committerDate !== details.commit.authorDate)
  ) {
    lines.push(
      `$(account) Committed by ${escapeMarkdown(details.committerName)} <${escapeMarkdown(details.committerEmail)}> · ${formatRelativeTime(details.committerDate, nowMs)}`,
    );
  }

  lines.push(primaryActions(data, commitNode), secondaryActions(data, commitNode));
  const preview = diffPreviewMarkdown(data.patchPreview);
  if (preview) lines.push("**Previous revision diff**", preview);
  return lines.join("\n\n");
}

function primaryActions(data: RichLineHover, commitNode: object): string {
  const actions = [
    link("Show Commit Details", COMMAND_IDS.showCommitDetails, [commitNode]),
    link("Open Revision", COMMAND_IDS.openFileAtRevision, [
      data.repositoryRoot,
      data.blame.sha,
      data.blame.path,
    ]),
  ];
  if (data.fileChange && data.parentSha !== undefined) {
    const scope: FileDiffScope = {
      fromSha: data.parentSha,
      label: data.blame.summary || shortSha(data.blame.sha),
      repositoryRootPath: data.repositoryRoot,
      toSha: data.blame.sha,
    };
    actions.splice(1, 0, link("Diff Previous", COMMAND_IDS.openLineDiff, [scope, data.fileChange]));
  }
  actions.push(
    link("Diff Working Tree", COMMAND_IDS.compareFileWithRevision, [
      data.repositoryRoot,
      data.blame.sha,
      data.filePath,
      shortSha(data.blame.sha),
    ]),
  );
  return actions.join(" · ");
}

function secondaryActions(data: RichLineHover, commitNode: object): string {
  return [
    link("File History", COMMAND_IDS.showFileHistory, [data.repositoryRoot, data.filePath]),
    link("Line History", COMMAND_IDS.showLineHistory, [
      data.repositoryRoot,
      data.filePath,
      data.lineNumber,
    ]),
    link("Copy SHA", COMMAND_IDS.copyCommitSha, [commitNode]),
    link("Copy Message", COMMAND_IDS.copyCommitMessage, [commitNode]),
    link("Open on GitLab", COMMAND_IDS.openGitLabFile, [
      data.repositoryRoot,
      data.blame.sha,
      data.blame.path,
      data.blame.originalLineNumber ?? data.lineNumber,
    ]),
  ].join(" · ");
}

function originalLocation(data: RichLineHover): string | null {
  const path = data.blame.path;
  const line = data.blame.originalLineNumber;
  if (!line && path === data.filePath) return null;
  return `Originally \`${escapeMarkdown(path)}${line ? `:${line.toString()}` : ""}\``;
}

function link(label: string, command: string, args: readonly unknown[]): string {
  return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

function diffPreviewMarkdown(patch: string | null | undefined): string | null {
  if (!patch) return null;
  const normalized = patch.replaceAll("\r", "");
  const lines = normalized.split("\n");
  let preview = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
  if (preview.length > MAX_PREVIEW_CHARACTERS) {
    preview = `${preview.slice(0, MAX_PREVIEW_CHARACTERS)}\n…`;
  } else if (lines.length > MAX_PREVIEW_LINES) {
    preview += "\n…";
  }
  const longestFence = Math.max(
    2,
    ...Array.from(preview.matchAll(/`+/gu), ([ticks]) => ticks.length),
  );
  const fence = "`".repeat(longestFence + 1);
  return `${fence}diff\n${preview}\n${fence}`;
}
