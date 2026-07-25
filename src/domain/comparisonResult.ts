import type { SavedComparisonV1 } from "./comparison";

export type FileChangeStatus =
  "added" | "copied" | "deleted" | "modified" | "renamed" | "typeChanged" | "unmerged";

export interface FileChange {
  readonly newPath: string;
  readonly oldPath?: string;
  readonly similarity?: number;
  readonly status: FileChangeStatus;
}

export interface ComparisonResult {
  readonly baseSha: string;
  readonly comparison: SavedComparisonV1;
  readonly files: readonly FileChange[];
  readonly fromSha: string;
  readonly mergeBaseSha?: string;
  readonly targetSha: string;
  readonly toSha: string;
}
