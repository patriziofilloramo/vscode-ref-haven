import { isAbsolute, relative, resolve, sep } from "node:path";

const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const WINDOWS_INVALID_SEGMENT_CHARACTER = /[<>:"\\|?*]/u;
const WINDOWS_RESERVED_SEGMENT =
  /^(?:(?:com|lpt)[1-9¹²³]|aux|clock\$|con|conin\$|conout\$|nul|prn)(?:\..*)?$/iu;

/** Validates a repository-relative path exactly as stored in a Git tree. */
export function isRepositoryRelativeGitPath(filePath: unknown): filePath is string {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    return false;
  }
  if (filePath.startsWith("/")) {
    return false;
  }
  const segments = filePath.split("/");
  return segments.every(isGitTreePathSegment);
}

export function assertRepositoryRelativeGitPath(filePath: unknown): asserts filePath is string {
  if (!isRepositoryRelativeGitPath(filePath)) {
    throw new Error("Git revision path is invalid.");
  }
}

/** Validates a Git path before it is exposed to the host working tree. */
export function isRepositoryWorktreeGitPath(filePath: unknown): filePath is string {
  return (
    isRepositoryRelativeGitPath(filePath) &&
    !isRepositoryMetadataPath(filePath) &&
    isMaterializableOnCurrentHost(filePath)
  );
}

/** Rejects host-incompatible paths and the repository metadata entry. */
export function assertRepositoryWorktreeGitPath(filePath: unknown): asserts filePath is string {
  assertRepositoryRelativeGitPath(filePath);
  if (isRepositoryMetadataPath(filePath)) {
    throw new Error("Repository metadata cannot be selected for this operation.");
  }
  if (!isMaterializableOnCurrentHost(filePath)) {
    throw new Error("Git path cannot be materialized safely on this host.");
  }
}

/** Resolves a worktree path and proves that it remains below the repository root. */
export function resolvePathWithinRepository(repositoryRoot: string, filePath: unknown): string {
  if (!isAbsolute(repositoryRoot)) throw new Error("Repository root must be absolute.");
  assertRepositoryWorktreeGitPath(filePath);

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

function isGitTreePathSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== "..";
}

function isRepositoryMetadataPath(filePath: string): boolean {
  return filePath.split("/", 1)[0]?.toLowerCase() === ".git";
}

function isMaterializableOnCurrentHost(filePath: string): boolean {
  if (process.platform !== "win32") return true;
  if (filePath.includes("\\") || WINDOWS_DRIVE_PATH.test(filePath)) return false;
  return filePath.split("/").every(isWindowsMaterializableSegment);
}

function isWindowsMaterializableSegment(segment: string): boolean {
  return (
    !WINDOWS_INVALID_SEGMENT_CHARACTER.test(segment) &&
    !hasAsciiControlCharacter(segment) &&
    !segment.endsWith(".") &&
    !segment.endsWith(" ") &&
    !WINDOWS_RESERVED_SEGMENT.test(segment)
  );
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 0x20) return true;
  }
  return false;
}
