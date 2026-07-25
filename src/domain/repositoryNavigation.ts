import type { BranchRef } from "./comparison";
import type { CommitInfo } from "./comparisonResult";

export interface BranchDetails {
  readonly ahead: number;
  readonly behind: number;
  readonly branch: BranchRef;
  readonly latestCommit: CommitInfo;
  readonly sha: string;
  readonly upstream?: string;
  readonly upstreamGone: boolean;
}

export interface WorktreeState {
  readonly changedPaths: number;
  readonly conflicted: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
}
