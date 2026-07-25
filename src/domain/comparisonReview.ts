import { createHash } from "node:crypto";

import type { ComparisonResult, FileChange } from "./comparisonResult";
import { isRepositoryRelativeGitPath } from "./pathValidation";

export const COMPARISON_REVIEW_STORAGE_KEY = "refhaven.comparisonReviews.v1";
export const MAX_REVIEW_RECORDS = 64;
export const MAX_REVIEW_RECORD_BYTES = 256 * 1_024;
export const MAX_REVIEW_STORAGE_BYTES = 4 * 1_024 * 1_024;
export const MAX_REVIEWED_PATHS = 10_000;
export const MAX_REVIEW_PATH_LENGTH = 4_096;

export type ComparisonFileFilter = "all" | "reviewed" | "unreviewed";
export type ComparisonFileSort = "changes" | "path" | "status";

export interface ComparisonReviewRecordV1 {
  readonly comparisonId: string;
  readonly reviewedPaths: readonly string[];
  readonly revisionKey: string;
  readonly schemaVersion: 1;
  readonly updatedAt: number;
}

export interface ComparisonReviewSummary {
  readonly reviewedCount: number;
  readonly reviewedPaths: ReadonlySet<string>;
  readonly revisionKey: string;
  readonly totalCount: number;
}

export function comparisonReviewRevision(result: ComparisonResult): string {
  const hash = createHash("sha256");
  appendHashPart(hash, "refhaven-comparison-review-v1");
  appendHashPart(hash, result.fromSha);
  appendHashPart(hash, result.toSha ?? "WORKING_TREE");
  if (result.toSha === null) appendHashPart(hash, result.computedAt.toString());
  for (const file of [...result.files].sort(compareFileIdentity)) {
    appendHashPart(hash, file.status);
    appendHashPart(hash, file.oldPath ?? "");
    appendHashPart(hash, file.newPath);
    appendHashPart(hash, file.additions?.toString() ?? "binary");
    appendHashPart(hash, file.deletions?.toString() ?? "binary");
  }
  return hash.digest("hex");
}

export function filterAndSortComparisonFiles(
  files: readonly FileChange[],
  reviewedPaths: ReadonlySet<string>,
  filter: ComparisonFileFilter,
  sort: ComparisonFileSort,
): FileChange[] {
  return files
    .filter((file) => {
      if (filter === "all") return true;
      const reviewed = reviewedPaths.has(file.newPath);
      return filter === "reviewed" ? reviewed : !reviewed;
    })
    .sort(fileComparator(sort));
}

export function isComparisonFileFilter(value: unknown): value is ComparisonFileFilter {
  return value === "all" || value === "reviewed" || value === "unreviewed";
}

export function isComparisonFileSort(value: unknown): value is ComparisonFileSort {
  return value === "changes" || value === "path" || value === "status";
}

export function isComparisonReviewRecordV1(value: unknown): value is ComparisonReviewRecordV1 {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1 ||
    typeof value.comparisonId !== "string" ||
    value.comparisonId.length === 0 ||
    value.comparisonId.length > 128 ||
    hasControlCharacter(value.comparisonId) ||
    typeof value.revisionKey !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.revisionKey) ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.updatedAt as number) < 0 ||
    !Array.isArray(value.reviewedPaths) ||
    value.reviewedPaths.length > MAX_REVIEWED_PATHS
  ) {
    return false;
  }
  const paths = value.reviewedPaths as unknown[];
  if (
    !paths.every(
      (path): path is string =>
        isRepositoryRelativeGitPath(path) && path.length <= MAX_REVIEW_PATH_LENGTH,
    )
  ) {
    return false;
  }
  return (
    new Set(paths).size === paths.length &&
    rawReviewRecordSize(value.comparisonId, value.revisionKey, paths) <= MAX_REVIEW_RECORD_BYTES
  );
}

export function comparisonReviewRecordSize(record: ComparisonReviewRecordV1): number {
  return rawReviewRecordSize(record.comparisonId, record.revisionKey, record.reviewedPaths);
}

function rawReviewRecordSize(
  comparisonId: string,
  revisionKey: string,
  reviewedPaths: readonly string[],
): number {
  return (
    96 +
    Buffer.byteLength(comparisonId, "utf8") +
    Buffer.byteLength(revisionKey, "utf8") +
    reviewedPaths.reduce((total, path) => total + Buffer.byteLength(path, "utf8") + 4, 0)
  );
}

function fileComparator(sort: ComparisonFileSort): (left: FileChange, right: FileChange) => number {
  return (left, right) => {
    if (sort === "status") {
      const statusDifference = statusOrder(left.status) - statusOrder(right.status);
      if (statusDifference !== 0) return statusDifference;
    } else if (sort === "changes") {
      const changeDifference = changeMagnitude(right) - changeMagnitude(left);
      if (changeDifference !== 0) return changeDifference;
    }
    return comparePaths(left.newPath, right.newPath);
  };
}

function compareFileIdentity(left: FileChange, right: FileChange): number {
  return (
    comparePaths(left.newPath, right.newPath) ||
    comparePaths(left.oldPath ?? "", right.oldPath ?? "") ||
    left.status.localeCompare(right.status)
  );
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function changeMagnitude(file: FileChange): number {
  if (file.additions === undefined && file.deletions === undefined) return -1;
  return (file.additions ?? 0) + (file.deletions ?? 0);
}

function statusOrder(status: FileChange["status"]): number {
  switch (status) {
    case "modified":
      return 0;
    case "added":
      return 1;
    case "deleted":
      return 2;
    case "renamed":
      return 3;
    case "copied":
      return 4;
    case "typeChanged":
      return 5;
    case "unmerged":
      return 6;
  }
}

function appendHashPart(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(value.length.toString());
  hash.update(":");
  hash.update(value);
  hash.update("\0");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
