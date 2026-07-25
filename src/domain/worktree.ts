export interface WorktreeInfo {
  readonly path: string;
  readonly headSha: string;
  readonly branchFullName?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockedReason?: string;
  readonly prunableReason?: string;
}
