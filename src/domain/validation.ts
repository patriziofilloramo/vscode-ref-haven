import { isAbsolute } from "node:path";

import type { BranchRef, SavedComparisonV1 } from "./comparison";
import type { FileChange } from "./comparisonResult";
import type { FileDiffScope } from "./fileDiffScope";
import { isRepositoryRelativeGitPath } from "./pathValidation";

const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/i;

export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

export function isBranchRef(value: unknown): value is BranchRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BranchRef>;
  return (
    isNonEmptyString(candidate.displayName) &&
    isValidBranchFullName(candidate.fullName) &&
    ((candidate.kind === "localBranch" && candidate.fullName.startsWith("refs/heads/")) ||
      (candidate.kind === "remoteBranch" && candidate.fullName.startsWith("refs/remotes/")))
  );
}

export function isSavedComparisonV1(value: unknown): value is SavedComparisonV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SavedComparisonV1>;
  return (
    candidate.schemaVersion === 1 &&
    isNonEmptyString(candidate.id) &&
    isFiniteNonNegativeNumber(candidate.createdAt) &&
    isFiniteNonNegativeNumber(candidate.updatedAt) &&
    Number.isSafeInteger(candidate.order) &&
    (candidate.order ?? -1) >= 0 &&
    typeof candidate.pinned === "boolean" &&
    (candidate.mode === "branchChanges" || candidate.mode === "tipToTip") &&
    isNonEmptyString(candidate.repository?.rootPath) &&
    isAbsolute(candidate.repository.rootPath) &&
    isNonEmptyString(candidate.repository.workspaceFolderUri) &&
    isNonEmptyString(candidate.repository.relativeRepositoryPath) &&
    isNonEmptyString(candidate.repository.label) &&
    (candidate.customLabel === undefined || isNonEmptyString(candidate.customLabel)) &&
    isBranchRef(candidate.baseRef) &&
    isBranchRef(candidate.targetRef)
  );
}

export function isFileChange(value: unknown): value is FileChange {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileChange>;
  return (
    isRepositoryRelativeGitPath(candidate.newPath) &&
    (candidate.oldPath === undefined || isRepositoryRelativeGitPath(candidate.oldPath)) &&
    isOptionalNonNegativeInteger(candidate.additions) &&
    isOptionalNonNegativeInteger(candidate.deletions) &&
    isOptionalPercentage(candidate.similarity) &&
    ["added", "copied", "deleted", "modified", "renamed", "typeChanged", "unmerged"].includes(
      candidate.status ?? "",
    ) &&
    ((candidate.status !== "renamed" && candidate.status !== "copied") ||
      candidate.oldPath !== undefined)
  );
}

export function isFileDiffScope(value: unknown): value is FileDiffScope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileDiffScope>;
  return (
    isNonEmptyString(candidate.label) &&
    isNonEmptyString(candidate.repositoryRootPath) &&
    isAbsolute(candidate.repositoryRootPath) &&
    (candidate.fromSha === null || isObjectId(candidate.fromSha)) &&
    isObjectId(candidate.toSha)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isOptionalPercentage(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100)
  );
}

function isValidBranchFullName(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (!value.startsWith("refs/heads/") && !value.startsWith("refs/remotes/")) return false;
  const relativeName = value.replace(/^refs\/(?:heads|remotes)\//, "");
  const segments = relativeName.split("/");
  return !(
    relativeName.length === 0 ||
    (value.startsWith("refs/remotes/") && value.endsWith("/HEAD")) ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    segments.some(
      (segment) => segment.length === 0 || segment.startsWith(".") || segment.endsWith(".lock"),
    ) ||
    hasInvalidRefCharacter(value)
  );
}

function hasInvalidRefCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "\\~^:?*[".includes(character)) return true;
  }
  return false;
}
