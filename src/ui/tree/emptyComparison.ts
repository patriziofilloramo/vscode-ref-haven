import type { ComparisonResult } from "../../domain/comparisonResult";

export interface EmptyComparisonExplanation {
  readonly cause: string;
  readonly remedy?: string;
}

/**
 * Explains an empty comparison once, so the collapsed section description, its
 * tooltip, and the expanded message nodes can never describe one result
 * differently.
 *
 * Branch-changes mode diffs the merge base against the target, so a target
 * whose commits are all contained in the base is legitimately empty. That
 * reads as a defect unless the direction is explained, because swapping the
 * two refs shows exactly the changes the reader expected.
 */
export function emptyComparisonExplanation(result: ComparisonResult): EmptyComparisonExplanation {
  const base = result.comparison.baseRef.displayName;
  const target = result.comparison.targetRef.displayName;
  if (result.aheadCount === 0 && result.behindCount === 0) {
    return {
      cause: `${target} and ${base} point at the same commit, so there is nothing to diff.`,
    };
  }
  if (result.comparison.mode === "branchChanges" && result.aheadCount === 0) {
    return {
      cause:
        `Branch-changes mode diffs the merge base against ${target}, and every commit of ` +
        `${target} is already part of ${base}.`,
      remedy:
        `Swap base and target to see what ${base} adds, or switch the comparison to ` +
        `tip-to-tip mode to see the full difference.`,
    };
  }
  return { cause: `The trees of ${base} and ${target} are identical for this comparison mode.` };
}

/** Condenses the same states into a label that fits beside the section title. */
export function emptyComparisonDescription(result: ComparisonResult): string {
  if (result.aheadCount === 0 && result.behindCount === 0) {
    return "branches point at the same commit";
  }
  if (result.comparison.mode === "branchChanges" && result.aheadCount === 0) {
    return `${result.comparison.targetRef.displayName} has no commits of its own`;
  }
  return "no differences";
}
