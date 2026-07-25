import assert from "node:assert/strict";
import { resolve } from "node:path";

import type * as vscode from "vscode";

import { ComparisonReviewStore } from "../../src/application/ComparisonReviewStore";
import type { SavedComparisonV1 } from "../../src/domain/comparison";
import {
  COMPARISON_REVIEW_STORAGE_KEY,
  comparisonReviewRevision,
  filterAndSortComparisonFiles,
  isComparisonReviewRecordV1,
} from "../../src/domain/comparisonReview";
import type { ComparisonResult, FileChange } from "../../src/domain/comparisonResult";

suite("comparison review domain", () => {
  test("creates an order-independent revision key that changes with endpoints or file state", () => {
    const result = createResult();
    const reordered = { ...result, files: [...result.files].reverse() };
    assert.equal(comparisonReviewRevision(result), comparisonReviewRevision(reordered));
    assert.notEqual(
      comparisonReviewRevision(result),
      comparisonReviewRevision({ ...result, toSha: "3".repeat(40) }),
    );
    assert.notEqual(
      comparisonReviewRevision(result),
      comparisonReviewRevision({
        ...result,
        files: result.files.map((file, index) =>
          index === 0 ? { ...file, additions: (file.additions ?? 0) + 1 } : file,
        ),
      }),
    );
    const workingTree = { ...result, computedAt: 10, toSha: null };
    assert.notEqual(
      comparisonReviewRevision(workingTree),
      comparisonReviewRevision({ ...workingTree, computedAt: 11 }),
    );
  });

  test("filters review state and applies deterministic path, status, and magnitude sorting", () => {
    const files = createFiles();
    const reviewed = new Set(["src/b.ts"]);
    assert.deepEqual(
      filterAndSortComparisonFiles(files, reviewed, "unreviewed", "path").map(
        ({ newPath }) => newPath,
      ),
      ["docs/readme.md", "src/a.ts"],
    );
    assert.deepEqual(
      filterAndSortComparisonFiles(files, reviewed, "all", "status").map(({ newPath }) => newPath),
      ["src/b.ts", "src/a.ts", "docs/readme.md"],
    );
    assert.deepEqual(
      filterAndSortComparisonFiles(files, reviewed, "all", "changes").map(({ newPath }) => newPath),
      ["src/a.ts", "src/b.ts", "docs/readme.md"],
    );
  });

  test("validates only bounded version-one persisted records", () => {
    const valid = {
      comparisonId: "comparison",
      reviewedPaths: ["src/a.ts"],
      revisionKey: "a".repeat(64),
      schemaVersion: 1,
      updatedAt: 1,
    };
    assert.equal(isComparisonReviewRecordV1(valid), true);
    assert.equal(isComparisonReviewRecordV1({ ...valid, revisionKey: {} }), false);
    assert.equal(isComparisonReviewRecordV1({ ...valid, reviewedPaths: ["../outside"] }), false);
    assert.equal(isComparisonReviewRecordV1({ ...valid, reviewedPaths: ["same", "same"] }), false);
    assert.equal(
      isComparisonReviewRecordV1({
        ...valid,
        reviewedPaths: Array.from(
          { length: 70 },
          (_, index) => `${index.toString()}-${"a".repeat(4_000)}`,
        ),
      }),
      false,
    );
  });
});

suite("ComparisonReviewStore", () => {
  test("persists current review state and invalidates it when the result revision changes", async () => {
    const state = new FakeWorkspaceState();
    const store = new ComparisonReviewStore(state.asWorkspaceState());
    const result = createResult();

    assert.equal(store.getSummary(result).reviewedCount, 0);
    await store.setReviewed(result, "src/a.ts", true);
    assert.deepEqual([...store.getSummary(result).reviewedPaths], ["src/a.ts"]);

    const moved = { ...result, toSha: "3".repeat(40) };
    assert.equal(store.getSummary(moved).reviewedCount, 0);
    await store.setReviewed(moved, "src/b.ts", true);
    assert.deepEqual([...store.getSummary(moved).reviewedPaths], ["src/b.ts"]);
    assert.equal((state.get(COMPARISON_REVIEW_STORAGE_KEY, []) as unknown[]).length, 1);
  });

  test("rejects stale paths and removes state for closed comparisons", async () => {
    const state = new FakeWorkspaceState();
    const store = new ComparisonReviewStore(state.asWorkspaceState());
    const result = createResult();

    await assert.rejects(() => store.setReviewed(result, "missing.ts", true), /no longer part/iu);
    await store.setAllReviewed(result, true);
    assert.equal(store.getSummary(result).reviewedCount, result.files.length);
    await store.removeComparison(result.comparison.id);
    assert.equal(store.getSummary(result).reviewedCount, 0);
  });
});

class FakeWorkspaceState {
  private readonly values = new Map<string, unknown>();

  public get(key: string, defaultValue?: unknown): unknown {
    return this.values.has(key) ? this.values.get(key) : defaultValue;
  }

  public update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  public asWorkspaceState(): Pick<vscode.ExtensionContext["workspaceState"], "get" | "update"> {
    return this as Pick<vscode.ExtensionContext["workspaceState"], "get" | "update">;
  }
}

function createResult(): ComparisonResult {
  const comparison: SavedComparisonV1 = {
    baseRef: { displayName: "main", fullName: "refs/heads/main", kind: "localBranch" },
    createdAt: 1,
    id: "comparison-review",
    mode: "branchChanges",
    order: 0,
    pinned: false,
    repository: {
      label: "fixture",
      relativeRepositoryPath: ".",
      rootPath: resolve("fixture"),
      workspaceFolderUri: "file:///fixture",
    },
    schemaVersion: 1,
    targetRef: {
      displayName: "feature",
      fullName: "refs/heads/feature",
      kind: "localBranch",
    },
    updatedAt: 1,
  };
  return {
    aheadCommits: [],
    aheadCount: 1,
    baseSha: "1".repeat(40),
    behindCommits: [],
    behindCount: 0,
    comparison,
    computedAt: 1,
    files: createFiles(),
    fromSha: "1".repeat(40),
    mergeBaseSha: "1".repeat(40),
    targetSha: "2".repeat(40),
    toSha: "2".repeat(40),
  };
}

function createFiles(): FileChange[] {
  return [
    { additions: 10, deletions: 5, newPath: "src/a.ts", status: "added" },
    { additions: 2, deletions: 1, newPath: "src/b.ts", status: "modified" },
    { additions: 0, deletions: 1, newPath: "docs/readme.md", status: "deleted" },
  ];
}
