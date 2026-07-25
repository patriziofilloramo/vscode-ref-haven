import type { MergePreview } from "../../domain/comparisonResult";
import { requireGitObjectId } from "../../domain/gitObjectId";
import { GitOperationError, normalizeGitError, runGitWithExitCode } from "./GitProcess";

/** Git's usage exit code, reported when `--write-tree` is not understood. */
const GIT_USAGE_EXIT_CODE = 129;

let writeTreeSupported = true;

/** Test seam: forgets whether the local Git understands `merge-tree --write-tree`. */
export function resetMergePreviewSupportCache(): void {
  writeTreeSupported = true;
}

/**
 * Predicts whether merging `targetSha` into `baseSha` would conflict, using
 * read-only `merge-tree --write-tree` plumbing (Git 2.38+): no worktree,
 * index, or ref is touched and nothing is checked out. Returns "unavailable"
 * instead of failing when the local Git cannot compute the preview (older
 * Git, unrelated histories), so callers degrade silently. An unsupported Git
 * is remembered for the session, so no further processes are spawned for it.
 */
export async function previewMerge(
  repositoryRoot: string,
  baseSha: string,
  targetSha: string,
  signal?: AbortSignal,
): Promise<MergePreview> {
  requireGitObjectId(baseSha, "The merge preview base revision is invalid.");
  requireGitObjectId(targetSha, "The merge preview target revision is invalid.");
  if (!writeTreeSupported) return { kind: "unavailable" };
  try {
    const { exitCode, stdout } = await runGitWithExitCode(
      repositoryRoot,
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", baseSha, targetSha],
      [1],
      signal,
    );
    if (exitCode === 0) return { kind: "clean" };
    const conflictedPaths = parseConflictedPaths(stdout);
    return conflictedPaths.length > 0
      ? { conflictedPaths, kind: "conflicts" }
      : { kind: "unavailable" };
  } catch (error) {
    const normalized = normalizeGitError(error);
    if (normalized instanceof GitOperationError && normalized.code === "commandCancelled") {
      throw normalized;
    }
    if ((error as { readonly code?: unknown }).code === GIT_USAGE_EXIT_CODE) {
      writeTreeSupported = false;
    }
    return { kind: "unavailable" };
  }
}

/** Parses `-z` merge-tree output: `<toplevel tree OID> NUL <conflicted path> NUL ...`. */
export function parseConflictedPaths(stdout: string): readonly string[] {
  return [...new Set(stdout.split("\0").slice(1))].filter((path) => path.length > 0);
}
