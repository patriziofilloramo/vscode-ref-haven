export const COMPARISON_STORAGE_KEY = "branchCompare.comparisons.v1";

export interface BranchRef {
  readonly displayName: string;
  readonly fullName: string;
  readonly kind: "localBranch" | "remoteBranch";
}

export interface RepositoryIdentity {
  readonly label: string;
  readonly relativeRepositoryPath: string;
  readonly rootPath: string;
  readonly workspaceFolderUri: string;
}

export interface SavedComparisonV1 {
  readonly baseRef: BranchRef;
  readonly createdAt: number;
  readonly customLabel?: string;
  readonly id: string;
  readonly mode: "branchChanges" | "tipToTip";
  readonly order: number;
  readonly pinned: boolean;
  readonly repository: RepositoryIdentity;
  readonly schemaVersion: 1;
  readonly targetRef: BranchRef;
  readonly updatedAt: number;
}

export type ComparisonIdentity = Pick<
  SavedComparisonV1,
  "baseRef" | "mode" | "repository" | "targetRef"
>;

export function comparisonLabel(comparison: SavedComparisonV1): string {
  return `${comparison.targetRef.displayName} relative to ${comparison.baseRef.displayName}`;
}

export function hasSameComparisonIdentity(
  left: ComparisonIdentity,
  right: ComparisonIdentity,
): boolean {
  return (
    left.repository.workspaceFolderUri === right.repository.workspaceFolderUri &&
    left.repository.relativeRepositoryPath === right.repository.relativeRepositoryPath &&
    left.baseRef.fullName === right.baseRef.fullName &&
    left.targetRef.fullName === right.targetRef.fullName &&
    left.mode === right.mode
  );
}

export function deduplicateComparisons(
  comparisons: readonly SavedComparisonV1[],
): SavedComparisonV1[] {
  const unique: SavedComparisonV1[] = [];

  for (const comparison of comparisons) {
    if (!unique.some((candidate) => hasSameComparisonIdentity(candidate, comparison))) {
      unique.push(comparison);
    }
  }

  return unique;
}
