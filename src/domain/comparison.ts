export const COMPARISON_STORAGE_KEY = "refhaven.comparisons.v1";
export const MAX_CUSTOM_LABEL_LENGTH = 100;

const NON_PRINTABLE_LABEL_PATTERN = /\p{C}/u;

export interface BranchRef {
  readonly displayName: string;
  readonly fullName: string;
  readonly kind: "head" | "localBranch" | "remoteBranch" | "revision" | "tag" | "workingTree";
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
  readonly mode: "branchChanges" | "tipToTip" | "workingTree";
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
  return (
    comparison.customLabel ??
    `${comparison.targetRef.displayName} relative to ${comparison.baseRef.displayName}`
  );
}

/**
 * Validates the canonical persisted representation of a custom label.
 * Labels are stored trimmed, non-empty, length-bounded, and free from
 * non-printable characters that could make tree labels misleading.
 */
export function isValidCustomLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    value.length <= MAX_CUSTOM_LABEL_LENGTH &&
    !NON_PRINTABLE_LABEL_PATTERN.test(value)
  );
}

export function withSwappedRefs(comparison: SavedComparisonV1, now: number): SavedComparisonV1 {
  return {
    ...comparison,
    baseRef: comparison.targetRef,
    targetRef: comparison.baseRef,
    updatedAt: now,
  };
}

export function withPinned(
  comparison: SavedComparisonV1,
  pinned: boolean,
  now: number,
): SavedComparisonV1 {
  return { ...comparison, pinned, updatedAt: now };
}

/** Sets or clears the user-chosen display label; `undefined` restores the default. */
export function withCustomLabel(
  comparison: SavedComparisonV1,
  customLabel: string | undefined,
  now: number,
): SavedComparisonV1 {
  if (customLabel !== undefined && !isValidCustomLabel(customLabel)) {
    throw new Error("The comparison name is invalid.");
  }
  return {
    baseRef: comparison.baseRef,
    createdAt: comparison.createdAt,
    ...(customLabel === undefined ? {} : { customLabel }),
    id: comparison.id,
    mode: comparison.mode,
    order: comparison.order,
    pinned: comparison.pinned,
    repository: comparison.repository,
    schemaVersion: comparison.schemaVersion,
    targetRef: comparison.targetRef,
    updatedAt: now,
  };
}

export function withMode(
  comparison: SavedComparisonV1,
  mode: SavedComparisonV1["mode"],
  now: number,
): SavedComparisonV1 {
  return { ...comparison, mode, updatedAt: now };
}

/** Pinned comparisons first, then by explicit order. */
export function sortComparisonsForDisplay(
  comparisons: readonly SavedComparisonV1[],
): SavedComparisonV1[] {
  return [...comparisons].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return left.order - right.order;
  });
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
    if (
      !unique.some(
        (candidate) =>
          candidate.id === comparison.id || hasSameComparisonIdentity(candidate, comparison),
      )
    ) {
      unique.push(comparison);
    }
  }

  return unique;
}
