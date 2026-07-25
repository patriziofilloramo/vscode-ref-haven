import type { RichLineHover } from "../../domain/blame";
import { shortSha } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import { COMMAND_IDS } from "../commands/commandIds";
import { formatDiffStats, formatRelativeTime, pluralize } from "../format";
import { GITLAB_AUTOLINK_COMMANDS, escapeMarkdownWithGitLabAutolinks } from "../gitLabAutolinks";
import { encodeCommandArguments, escapeMarkdown } from "../markdown";
import { blameAuthorLabel, blameCommitInfo } from "./blamePresentation";
import { selectDiffPreviewSection, windowAroundTarget } from "./diffPreview";

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
  ...GITLAB_AUTOLINK_COMMANDS,
];

export function richBlameHoverMarkdown(data: RichLineHover, nowMs = Date.now()): string {
  const { blame } = data;
  const author = escapeMarkdown(blameAuthorLabel(blame, data.userName));
  if (!blame.isCommitted) {
    return `**${author}** · Uncommitted changes`;
  }

  const commit = blameCommitInfo(blame);
  const commitNode = { commit, kind: "commit", repositoryRoot: data.repositoryRoot };

  // Ordered by the question a hover answers: who and when, why (the commit
  // message), what actually changed, and only then the supporting metadata.
  // The full SHA lives behind "Copy SHA" instead of consuming a line here.
  const lines = [
    `**${author}** · ${formatRelativeTime(blame.authorDate, nowMs)} · \`${shortSha(blame.sha)}\``,
    `**${
      blame.summary.length > 0
        ? escapeMarkdownWithGitLabAutolinks(blame.summary, data.repositoryRoot)
        : escapeMarkdown("(no commit message)")
    }**`,
    ...diffPreviewMarkdown(data),
    ...metadataLines(data, nowMs),
    primaryActions(data, commitNode),
    secondaryActions(data, commitNode),
  ];
  return lines.join("\n\n");
}

/**
 * Supporting facts, kept below the diff: scope of the commit, where the line
 * came from, the exact timestamp and email, and a committer that differs from
 * the author.
 */
function metadataLines(data: RichLineHover, nowMs: number): readonly string[] {
  const { blame } = data;
  const details = data.commitDetails;
  const lines: string[] = [];

  const scope: string[] = [];
  if (data.changedFileCount !== undefined) {
    scope.push(pluralize(data.changedFileCount, "changed file"));
  }
  const change = data.fileChange;
  if (change && (change.additions !== undefined || change.deletions !== undefined)) {
    scope.push(`${formatDiffStats(change.additions ?? 0, change.deletions ?? 0)} here`);
  }
  const location = originalLocation(data);
  if (location) scope.push(location);
  if (scope.length > 0) lines.push(`$(files) ${scope.join(" · ")}`);

  const identity = [new Date(blame.authorDate).toLocaleString()];
  if (details?.authorEmail) identity.push(`<${escapeMarkdown(details.authorEmail)}>`);
  lines.push(`$(calendar) ${identity.join(" · ")}`);

  if (
    details &&
    (details.committerName !== details.commit.authorName ||
      details.committerDate !== details.commit.authorDate)
  ) {
    lines.push(
      `$(account) Committed by ${escapeMarkdown(details.committerName)} <${escapeMarkdown(details.committerEmail)}> · ${formatRelativeTime(details.committerDate, nowMs)}`,
    );
  }
  return lines;
}

function primaryActions(data: RichLineHover, commitNode: object): string {
  const actions = [
    link("Commit Details", COMMAND_IDS.showCommitDetails, [commitNode]),
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
  if (data.blame.previousSha && data.blame.previousPath) {
    // Opens the file just before the blamed commit; hovering there continues
    // the blame chain further back (time-travel blame).
    actions.push(
      link("Before This Change", COMMAND_IDS.openFileAtRevision, [
        data.repositoryRoot,
        data.blame.previousSha,
        data.blame.previousPath,
      ]),
    );
  }
  actions.push(
    link("Diff Working Tree", COMMAND_IDS.compareFileWithRevision, [
      data.repositoryRoot,
      data.blame.sha,
      data.filePath,
      shortSha(data.blame.sha),
    ]),
  );
  return `$(zap) ${actions.join(" · ")}`;
}

/** Subordinate row: useful, but never the reason someone opened the hover. */
function secondaryActions(data: RichLineHover, commitNode: object): string {
  const actions = [
    link("File History", COMMAND_IDS.showFileHistory, [data.repositoryRoot, data.filePath]),
    link("Line History", COMMAND_IDS.showLineHistory, [
      data.repositoryRoot,
      data.filePath,
      data.lineNumber,
    ]),
    link("Copy SHA", COMMAND_IDS.copyCommitSha, [commitNode]),
    link("Copy Message", COMMAND_IDS.copyCommitMessage, [commitNode]),
    link("Open in Browser", COMMAND_IDS.openGitLabFile, [
      data.repositoryRoot,
      data.blame.sha,
      data.blame.path,
      data.blame.originalLineNumber ?? data.lineNumber,
    ]),
  ];
  return `$(ellipsis) ${actions.join(" · ")}`;
}

function originalLocation(data: RichLineHover): string | null {
  const path = data.blame.path;
  const line = data.blame.originalLineNumber;
  const samePath = path === data.filePath;
  if (samePath && (line === undefined || line === data.lineNumber)) return null;
  return `Originally \`${escapeMarkdown(path)}${line ? `:${line.toString()}` : ""}\``;
}

function link(label: string, command: string, args: readonly unknown[]): string {
  return `[${label}](command:${command}?${encodeCommandArguments(args)})`;
}

/**
 * Renders the change that produced the hovered line: a caption naming the
 * location, then only that diff section. Returns null when the commit made no
 * textual change to the file (binary or mode-only).
 */
function diffPreviewMarkdown(data: RichLineHover): readonly string[] {
  const patch = data.patchPreview;
  if (!patch) return [];
  const section = selectDiffPreviewSection(patch, data.blame.originalLineNumber);
  if (!section) return [];

  const { lines, trimmedEnd, trimmedStart } = windowAroundTarget(
    section.bodyLines,
    MAX_PREVIEW_LINES,
    section.targetIndex,
  );
  let body = [...(trimmedStart ? ["…"] : []), ...lines, ...(trimmedEnd ? ["…"] : [])].join("\n");
  if (body.length > MAX_PREVIEW_CHARACTERS) {
    body = `${body.slice(0, MAX_PREVIEW_CHARACTERS)}\n…`;
  }

  const location = section.containsTarget
    ? `line ${(data.blame.originalLineNumber ?? data.lineNumber).toString()}`
    : `line ${section.newStartLine.toString()}`;
  const others =
    section.totalSections > 1
      ? ` · ${pluralize(section.totalSections - 1, "other changed section")} in this file`
      : "";
  const caption = section.containsTarget
    ? `$(diff) **What changed here** · ${location}${others}`
    : `$(diff) **What this commit changed** · ${location}${others}`;

  const longestFence = Math.max(2, ...Array.from(body.matchAll(/`+/gu), ([ticks]) => ticks.length));
  const fence = "`".repeat(longestFence + 1);
  return [caption, `${fence}diff\n${body}\n${fence}`];
}
