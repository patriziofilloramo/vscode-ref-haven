import type { SavedComparisonV1 } from "../domain/comparison";
import { COMMIT_PAGE_SIZE, type ComparisonResult } from "../domain/comparisonResult";
import {
  countAheadBehind,
  findMergeBase,
  listChangedFiles,
  listCommitRange,
  resolveRef,
} from "../infrastructure/git/GitCli";

export async function calculateComparison(
  comparison: SavedComparisonV1,
  signal?: AbortSignal,
): Promise<ComparisonResult> {
  const abortController = new AbortController();
  const abort = (): void => abortController.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    return await calculateComparisonCore(comparison, abortController.signal);
  } catch (error) {
    abortController.abort();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function calculateComparisonCore(
  comparison: SavedComparisonV1,
  signal: AbortSignal,
): Promise<ComparisonResult> {
  const repositoryRoot = comparison.repository.rootPath;
  const [baseSha, targetSha] = await Promise.all([
    resolveRef(repositoryRoot, comparison.baseRef.fullName, signal),
    resolveRef(repositoryRoot, comparison.targetRef.fullName, signal),
  ]);

  const mergeBaseSha =
    comparison.mode === "branchChanges"
      ? await findMergeBase(repositoryRoot, baseSha, targetSha, signal)
      : undefined;
  if (comparison.mode === "branchChanges" && !mergeBaseSha) {
    throw new Error(
      "These branches have no common ancestor. Recreate the comparison in tip-to-tip mode.",
    );
  }

  const fromSha = comparison.mode === "branchChanges" ? mergeBaseSha : baseSha;
  if (!fromSha) throw new Error("Could not determine the comparison start revision.");

  const [files, counts, aheadCommits, behindCommits] = await Promise.all([
    listChangedFiles(repositoryRoot, fromSha, targetSha, signal),
    countAheadBehind(repositoryRoot, baseSha, targetSha, signal),
    listCommitRange(repositoryRoot, baseSha, targetSha, COMMIT_PAGE_SIZE, signal),
    listCommitRange(repositoryRoot, targetSha, baseSha, COMMIT_PAGE_SIZE, signal),
  ]);

  return {
    aheadCommits,
    aheadCount: counts.ahead,
    baseSha,
    behindCommits,
    behindCount: counts.behind,
    comparison,
    computedAt: Date.now(),
    files,
    fromSha,
    ...(mergeBaseSha ? { mergeBaseSha } : {}),
    targetSha,
    toSha: targetSha,
  };
}
