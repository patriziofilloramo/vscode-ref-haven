import type { CommitInfo, FileChange } from "./comparisonResult";

export interface HistoryEntry {
  readonly commit: CommitInfo;
  readonly parentSha: string | null;
}

export interface FileHistoryEntry extends HistoryEntry {
  readonly change: FileChange;
}

export interface LineHistoryRange {
  /** One-based first line on the commit side of the history diff. */
  readonly startLine: number;
  /** Zero represents a deletion positioned between surviving lines. */
  readonly lineCount: number;
}

export interface LineHistoryEntry extends HistoryEntry {
  /** Hunk ranges emitted by `git log -L` for this specific revision. */
  readonly lineChanges: readonly LineHistoryRange[];
}

interface HistoryTargetBase {
  readonly filePath: string;
  readonly repositoryRoot: string;
}

export interface FileHistoryTarget extends HistoryTargetBase {
  readonly kind: "file";
}

export interface LineHistoryTarget extends HistoryTargetBase {
  readonly endLine: number;
  readonly kind: "line";
  readonly startLine: number;
}

export type HistoryTarget = FileHistoryTarget | LineHistoryTarget;

export type HistoryPageCursor =
  | {
      readonly filePath: string;
      readonly kind: "file";
      readonly revision: string;
    }
  | {
      readonly kind: "line";
      readonly offset: number;
    };

export interface HistoryPage<TEntry extends HistoryEntry = HistoryEntry> {
  readonly entries: readonly TEntry[];
  readonly hasMore: boolean;
  readonly nextCursor: HistoryPageCursor | undefined;
}

export interface HistoryPageRequest {
  readonly cursor: HistoryPageCursor | undefined;
  readonly followRenames: boolean;
  readonly limit: number;
}

export function isFileHistoryEntry(entry: HistoryEntry): entry is FileHistoryEntry {
  return "change" in entry;
}

export function isLineHistoryEntry(entry: HistoryEntry): entry is LineHistoryEntry {
  return "lineChanges" in entry;
}
