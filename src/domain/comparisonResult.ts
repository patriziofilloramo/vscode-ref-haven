import type { SavedComparisonV1 } from "./comparison";

/** Commits shown per ahead/behind section before truncation. */
export const COMMIT_PAGE_SIZE = 50;

export type FileChangeStatus =
  "added" | "copied" | "deleted" | "modified" | "renamed" | "typeChanged" | "unmerged";

export interface FileChange {
  /** Added line count; undefined when the change is binary. */
  readonly additions?: number;
  /** Deleted line count; undefined when the change is binary. */
  readonly deletions?: number;
  readonly newPath: string;
  readonly oldPath?: string;
  readonly similarity?: number;
  readonly status: FileChangeStatus;
}

export interface CommitInfo {
  /** Author date in epoch milliseconds. */
  readonly authorDate: number;
  readonly authorName: string;
  readonly sha: string;
  readonly subject: string;
}

export interface ComparisonResult {
  /** Commits reachable from the target but not the base, newest first. */
  readonly aheadCommits: readonly CommitInfo[];
  readonly aheadCount: number;
  readonly baseSha: string;
  /** Commits reachable from the base but not the target, newest first. */
  readonly behindCommits: readonly CommitInfo[];
  readonly behindCount: number;
  readonly comparison: SavedComparisonV1;
  /** Epoch milliseconds at which this result was computed. */
  readonly computedAt: number;
  readonly files: readonly FileChange[];
  readonly fromSha: string;
  readonly mergeBaseSha?: string;
  readonly targetSha: string;
  /** Right-side revision; null represents the live working tree. */
  readonly toSha: string | null;
}

export interface DiffTotals {
  readonly additions: number;
  readonly binaryFileCount: number;
  readonly deletions: number;
}

export function sumDiffTotals(files: readonly FileChange[]): DiffTotals {
  let additions = 0;
  let binaryFileCount = 0;
  let deletions = 0;
  for (const file of files) {
    if (file.additions === undefined && file.deletions === undefined) {
      binaryFileCount += 1;
      continue;
    }
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { additions, binaryFileCount, deletions };
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
