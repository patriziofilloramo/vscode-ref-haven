import { isAbsolute, relative, resolve, sep } from "node:path";

const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;

/**
 * Git paths use forward slashes on every platform. Backslashes are rejected so
 * a path created on POSIX cannot become a directory traversal on Windows.
 */
export function isRepositoryRelativeGitPath(filePath: unknown): filePath is string {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    return false;
  }
  if (filePath.includes("\\") || filePath.startsWith("/") || WINDOWS_DRIVE_PATH.test(filePath)) {
    return false;
  }

  const segments = filePath.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function assertRepositoryRelativeGitPath(filePath: unknown): asserts filePath is string {
  if (!isRepositoryRelativeGitPath(filePath)) {
    throw new Error("Git revision path is invalid.");
  }
}

/** Rejects the repository metadata entry while accepting normal worktree paths. */
export function assertRepositoryWorktreeGitPath(filePath: unknown): asserts filePath is string {
  assertRepositoryRelativeGitPath(filePath);
  if (filePath.split("/", 1)[0]?.toLowerCase() === ".git") {
    throw new Error("Repository metadata cannot be selected for this operation.");
  }
}

/** Resolves a Git path and proves that the result remains below the repository root. */
export function resolvePathWithinRepository(repositoryRoot: string, filePath: unknown): string {
  if (!isAbsolute(repositoryRoot)) throw new Error("Repository root must be absolute.");
  assertRepositoryRelativeGitPath(filePath);

  const root = resolve(repositoryRoot);
  const candidate = resolve(root, ...filePath.split("/"));
  const relativePath = relative(root, candidate);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Git path resolves outside the repository.");
  }
  return candidate;
}

export function pathIdentityKey(filePath: string): string {
  const normalized = resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
