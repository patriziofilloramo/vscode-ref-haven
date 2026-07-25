import type * as vscode from "vscode";

import {
  COMPARISON_REVIEW_STORAGE_KEY,
  MAX_REVIEW_PATH_LENGTH,
  MAX_REVIEW_RECORD_BYTES,
  MAX_REVIEW_RECORDS,
  MAX_REVIEW_STORAGE_BYTES,
  MAX_REVIEWED_PATHS,
  comparisonReviewRevision,
  comparisonReviewRecordSize,
  isComparisonReviewRecordV1,
  type ComparisonReviewRecordV1,
  type ComparisonReviewSummary,
} from "../domain/comparisonReview";
import type { ComparisonResult } from "../domain/comparisonResult";

type WorkspaceState = Pick<vscode.ExtensionContext["workspaceState"], "get" | "update">;

export class ComparisonReviewStore {
  private recordsCache: readonly ComparisonReviewRecordV1[] | undefined;
  private readonly resultMetadata = new WeakMap<
    ComparisonResult,
    { readonly currentPaths: ReadonlySet<string>; readonly revisionKey: string }
  >();

  public constructor(private readonly workspaceState: WorkspaceState) {}

  public getSummary(result: ComparisonResult): ComparisonReviewSummary {
    let metadata = this.resultMetadata.get(result);
    if (!metadata) {
      metadata = {
        currentPaths: new Set(result.files.map(({ newPath }) => newPath)),
        revisionKey: comparisonReviewRevision(result),
      };
      this.resultMetadata.set(result, metadata);
    }
    const record = this.getRecords().find(
      (candidate) =>
        candidate.comparisonId === result.comparison.id &&
        candidate.revisionKey === metadata.revisionKey,
    );
    const reviewedPaths = new Set(
      (record?.reviewedPaths ?? []).filter((path) => metadata.currentPaths.has(path)),
    );
    return {
      reviewedCount: reviewedPaths.size,
      reviewedPaths,
      revisionKey: metadata.revisionKey,
      totalCount: result.files.length,
    };
  }

  public async setReviewed(
    result: ComparisonResult,
    filePath: string,
    reviewed: boolean,
  ): Promise<ComparisonReviewSummary> {
    if (!result.files.some(({ newPath }) => newPath === filePath)) {
      throw new Error("The selected file is no longer part of this comparison.");
    }
    if (filePath.length > MAX_REVIEW_PATH_LENGTH) {
      throw new Error("The selected file path is too long to persist as review state.");
    }
    const summary = this.getSummary(result);
    const reviewedPaths = new Set(summary.reviewedPaths);
    if (reviewed) reviewedPaths.add(filePath);
    else reviewedPaths.delete(filePath);
    await this.persistRecord(result.comparison.id, summary.revisionKey, reviewedPaths);
    return { ...summary, reviewedCount: reviewedPaths.size, reviewedPaths };
  }

  public async setAllReviewed(
    result: ComparisonResult,
    reviewed: boolean,
  ): Promise<ComparisonReviewSummary> {
    if (reviewed && result.files.length > MAX_REVIEWED_PATHS) {
      throw new Error(
        `Review state is limited to ${MAX_REVIEWED_PATHS.toLocaleString()} files per comparison.`,
      );
    }
    if (reviewed && result.files.some(({ newPath }) => newPath.length > MAX_REVIEW_PATH_LENGTH)) {
      throw new Error("One or more file paths are too long to persist as review state.");
    }
    const revisionKey = this.getSummary(result).revisionKey;
    const reviewedPaths = new Set(reviewed ? result.files.map(({ newPath }) => newPath) : []);
    await this.persistRecord(result.comparison.id, revisionKey, reviewedPaths);
    return {
      reviewedCount: reviewedPaths.size,
      reviewedPaths,
      revisionKey,
      totalCount: result.files.length,
    };
  }

  public async removeComparison(comparisonId: string): Promise<void> {
    await this.persist(this.getRecords().filter((record) => record.comparisonId !== comparisonId));
  }

  public async prune(validComparisonIds: ReadonlySet<string>): Promise<void> {
    const current = this.getRecords();
    const retained = current.filter((record) => validComparisonIds.has(record.comparisonId));
    if (retained.length !== current.length) await this.persist(retained);
  }

  private getRecords(): ComparisonReviewRecordV1[] {
    if (this.recordsCache) return [...this.recordsCache];
    const raw = this.workspaceState.get<unknown>(COMPARISON_REVIEW_STORAGE_KEY, []);
    if (!Array.isArray(raw)) {
      this.recordsCache = [];
      return [];
    }
    const byComparison = new Map<string, ComparisonReviewRecordV1>();
    for (const record of raw.filter(isComparisonReviewRecordV1)) {
      const existing = byComparison.get(record.comparisonId);
      if (!existing || record.updatedAt > existing.updatedAt) {
        byComparison.set(record.comparisonId, record);
      }
    }
    const records = retainBoundedRecords([...byComparison.values()]);
    this.recordsCache = records;
    return [...records];
  }

  private async persistRecord(
    comparisonId: string,
    revisionKey: string,
    reviewedPaths: ReadonlySet<string>,
  ): Promise<void> {
    if (reviewedPaths.size > MAX_REVIEWED_PATHS) {
      throw new Error(
        `Review state is limited to ${MAX_REVIEWED_PATHS.toLocaleString()} files per comparison.`,
      );
    }
    const record: ComparisonReviewRecordV1 = {
      comparisonId,
      reviewedPaths: [...reviewedPaths].sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
      ),
      revisionKey,
      schemaVersion: 1,
      updatedAt: Date.now(),
    };
    if (comparisonReviewRecordSize(record) > MAX_REVIEW_RECORD_BYTES) {
      throw new Error("The comparison review is too large to persist safely.");
    }
    await this.persist([
      record,
      ...this.getRecords().filter((candidate) => candidate.comparisonId !== comparisonId),
    ]);
  }

  private async persist(records: readonly ComparisonReviewRecordV1[]): Promise<void> {
    const retained = retainBoundedRecords(records);
    await this.workspaceState.update(COMPARISON_REVIEW_STORAGE_KEY, retained);
    this.recordsCache = retained;
  }
}

function retainBoundedRecords(
  records: readonly ComparisonReviewRecordV1[],
): ComparisonReviewRecordV1[] {
  const retained: ComparisonReviewRecordV1[] = [];
  let totalBytes = 0;
  for (const record of [...records].sort((left, right) => right.updatedAt - left.updatedAt)) {
    const recordBytes = comparisonReviewRecordSize(record);
    if (
      retained.length >= MAX_REVIEW_RECORDS ||
      totalBytes + recordBytes > MAX_REVIEW_STORAGE_BYTES
    ) {
      continue;
    }
    retained.push(record);
    totalBytes += recordBytes;
  }
  return retained;
}
