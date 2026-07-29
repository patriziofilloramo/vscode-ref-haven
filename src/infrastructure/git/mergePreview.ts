import type { MergePreview } from "../../domain/comparisonResult";
import { requireGitObjectId } from "../../domain/gitObjectId";
import { isRepositoryRelativeGitPath } from "../../domain/pathValidation";
import { GitOperationError, normalizeGitError, runGitWithExitCode } from "./GitProcess";

/** Git's usage exit code, reported when `--write-tree` is not understood. */
const GIT_USAGE_EXIT_CODE = 129;
const EXTERNAL_MERGE_DRIVER_KEY_PATTERN = "^merge\\..*\\.driver$";

let writeTreeSupported = true;

type MergePreviewGitRunner = (
  cwd: string,
  args: readonly string[],
  acceptedExitCodes: readonly number[],
  signal?: AbortSignal,
) => Promise<{ readonly exitCode: number; readonly stdout: string }>;

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
  run: MergePreviewGitRunner = runGitWithExitCode,
): Promise<MergePreview> {
  requireGitObjectId(baseSha, "The merge preview base revision is invalid.");
  requireGitObjectId(targetSha, "The merge preview target revision is invalid.");
  if (!writeTreeSupported) return { kind: "unavailable" };

  // `merge-tree` uses the normal low-level merge machinery. A repository can
  // therefore pair `merge=<name>` in .gitattributes with
  // `merge.<name>.driver` in Git config and make this otherwise read-only
  // preview start an arbitrary shell command. Probe every effective config
  // scope (including include files) and fail closed before invoking it.
  try {
    const { exitCode } = await run(
      repositoryRoot,
      ["config", "--includes", "--name-only", "--get-regexp", EXTERNAL_MERGE_DRIVER_KEY_PATTERN],
      [1],
      signal,
    );
    if (exitCode === 0) return { kind: "unavailable" };
  } catch (error) {
    rethrowCancellation(error);
    return { kind: "unavailable" };
  }

  try {
    const { exitCode, stdout } = await run(
      repositoryRoot,
      [
        "-c",
        "merge.renormalize=false",
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "-z",
        baseSha,
        targetSha,
      ],
      [1],
      signal,
    );
    if (exitCode === 0) return { kind: "clean" };
    const conflictedPaths = parseConflictedPaths(stdout);
    return conflictedPaths.length > 0
      ? { conflictedPaths, kind: "conflicts" }
      : { kind: "unavailable" };
  } catch (error) {
    rethrowCancellation(error);
    if ((error as { readonly code?: unknown }).code === GIT_USAGE_EXIT_CODE) {
      writeTreeSupported = false;
    }
    return { kind: "unavailable" };
  }
}

function rethrowCancellation(error: unknown): void {
  const normalized = normalizeGitError(error);
  if (normalized instanceof GitOperationError && normalized.code === "commandCancelled") {
    throw normalized;
  }
}

/** Parses `-z` merge-tree output: `<toplevel tree OID> NUL <conflicted path> NUL ...`. */
export function parseConflictedPaths(stdout: string): readonly string[] {
  const paths = stdout
    .split("\0")
    .slice(1)
    .filter((path) => path.length > 0);
  if (paths.some((path) => !isRepositoryRelativeGitPath(path))) {
    throw new Error("Git returned an invalid merge-conflict path.");
  }
  return [...new Set(paths)];
}
