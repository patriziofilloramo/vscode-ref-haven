import { isAbsolute } from "node:path";

import { requireGitObjectId } from "../../domain/gitObjectId";
import { MAX_STASH_MESSAGE_LENGTH } from "../../domain/inputLimits";
import {
  assertRepositoryWorktreeGitPath,
  pathIdentityKey,
  resolvePathWithinRepository,
} from "../../domain/pathValidation";

export interface StashFileHookContext {
  readonly pathspecs: readonly string[];
  readonly repositoryRoot: string;
  readonly safetyCopyDirectory: string;
  readonly stashSha: string;
}

/** Internal deterministic barriers used only by real-repository regression tests. */
export interface StashFileTestHooks {
  readonly afterEvacuate?: (context: StashFileHookContext) => Promise<void> | void;
  readonly afterIndexCleanup?: (context: StashFileHookContext) => Promise<void> | void;
  readonly afterWorktreeCleanup?: (context: StashFileHookContext) => Promise<void> | void;
  readonly beforeEvacuate?: (context: StashFileHookContext) => Promise<void> | void;
  readonly beforeIndexCleanup?: (context: StashFileHookContext) => Promise<void> | void;
  readonly beforeStashRefUpdate?: (context: StashFileHookContext) => Promise<void> | void;
}

export interface PathLimitedStashRequest {
  readonly branchName: string;
  readonly headSha: string;
  readonly message: string;
  readonly pathspecs: readonly string[];
  readonly repositoryRoot: string;
  readonly testHooks?: StashFileTestHooks;
}

export function snapshotAndValidateRequest(
  request: PathLimitedStashRequest,
): PathLimitedStashRequest {
  if (
    !isAbsolute(request.repositoryRoot) ||
    request.repositoryRoot.includes("\0") ||
    request.pathspecs.length < 1 ||
    request.pathspecs.length > 2
  ) {
    throw new Error("The single-file stash request is invalid.");
  }
  requireGitObjectId(request.headSha, "The stash base revision is invalid.");
  if (
    request.message.trim().length < 1 ||
    request.message.trim().length > MAX_STASH_MESSAGE_LENGTH ||
    request.message.includes("\0") ||
    /[\r\n]/u.test(request.message) ||
    request.branchName.length < 1 ||
    request.branchName.length > 1_024 ||
    request.branchName.includes("\0") ||
    /[\r\n]/u.test(request.branchName)
  ) {
    throw new Error("The single-file stash metadata is invalid.");
  }
  const pathspecs = [...request.pathspecs];
  for (const pathspec of pathspecs) assertRepositoryWorktreeGitPath(pathspec);
  if (new Set(pathspecs).size !== pathspecs.length) {
    throw new Error("The single-file stash paths must be unique.");
  }
  const targetKeys = pathspecs.map((pathspec) => {
    const key = pathIdentityKey(resolvePathWithinRepository(request.repositoryRoot, pathspec));
    return process.platform === "darwin" ? key.toLowerCase() : key;
  });
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new Error("Single-file stash does not support a case-only rename on this filesystem.");
  }
  return {
    branchName: request.branchName,
    headSha: request.headSha,
    message: request.message,
    pathspecs,
    repositoryRoot: request.repositoryRoot,
    ...(request.testHooks ? { testHooks: request.testHooks } : {}),
  };
}
