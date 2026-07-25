import type { BranchRef, SavedComparisonV1 } from "./comparison";
import type { FileChange } from "./comparisonResult";
import type { FileDiffScope } from "./fileDiffScope";

const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/i;

export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

export function isBranchRef(value: unknown): value is BranchRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BranchRef>;
  return (
    typeof candidate.displayName === "string" &&
    typeof candidate.fullName === "string" &&
    (candidate.kind === "localBranch" || candidate.kind === "remoteBranch")
  );
}

export function isSavedComparisonV1(value: unknown): value is SavedComparisonV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SavedComparisonV1>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.order === "number" &&
    typeof candidate.pinned === "boolean" &&
    typeof candidate.repository?.rootPath === "string" &&
    typeof candidate.repository.workspaceFolderUri === "string" &&
    typeof candidate.repository.relativeRepositoryPath === "string" &&
    typeof candidate.repository.label === "string" &&
    isBranchRef(candidate.baseRef) &&
    isBranchRef(candidate.targetRef)
  );
}

export function isFileChange(value: unknown): value is FileChange {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileChange>;
  return (
    typeof candidate.newPath === "string" &&
    ["added", "copied", "deleted", "modified", "renamed", "typeChanged", "unmerged"].includes(
      candidate.status ?? "",
    )
  );
}

export function isFileDiffScope(value: unknown): value is FileDiffScope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileDiffScope>;
  return (
    typeof candidate.label === "string" &&
    typeof candidate.repositoryRootPath === "string" &&
    (candidate.fromSha === null || isObjectId(candidate.fromSha)) &&
    isObjectId(candidate.toSha)
  );
}
