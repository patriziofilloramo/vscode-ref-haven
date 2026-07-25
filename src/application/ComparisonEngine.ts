import type { SavedComparisonV1 } from "../domain/comparison";
import type { ComparisonResult } from "../domain/comparisonResult";
import { findMergeBase, listChangedFiles, resolveRef } from "../infrastructure/git/GitCli";

export async function calculateComparison(
  comparison: SavedComparisonV1,
): Promise<ComparisonResult> {
  const [baseSha, targetSha] = await Promise.all([
    resolveRef(comparison.repository.rootPath, comparison.baseRef.fullName),
    resolveRef(comparison.repository.rootPath, comparison.targetRef.fullName),
  ]);

  const mergeBaseSha =
    comparison.mode === "branchChanges"
      ? await findMergeBase(comparison.repository.rootPath, baseSha, targetSha)
      : undefined;
  if (comparison.mode === "branchChanges" && !mergeBaseSha) {
    throw new Error(
      "These branches have no common ancestor. Recreate the comparison in tip-to-tip mode.",
    );
  }

  const fromSha = comparison.mode === "branchChanges" ? mergeBaseSha : baseSha;
  if (!fromSha) throw new Error("Could not determine the comparison start revision.");

  const files = await listChangedFiles(comparison.repository.rootPath, fromSha, targetSha);
  return {
    baseSha,
    comparison,
    files,
    fromSha,
    ...(mergeBaseSha ? { mergeBaseSha } : {}),
    targetSha,
    toSha: targetSha,
  };
}
