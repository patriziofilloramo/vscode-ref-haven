import type { CommitInfo, FileChange } from "./comparisonResult";

export interface FileHistoryEntry {
  readonly change: FileChange;
  readonly commit: CommitInfo;
  readonly parentSha: string | null;
}

export interface FileHistoryTarget {
  readonly filePath: string;
  readonly repositoryRoot: string;
}
