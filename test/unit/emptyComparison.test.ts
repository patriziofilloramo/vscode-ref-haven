import assert from "node:assert/strict";

import type { SavedComparisonV1 } from "../../src/domain/comparison";
import type { ComparisonResult } from "../../src/domain/comparisonResult";
import {
  emptyComparisonDescription,
  emptyComparisonExplanation,
} from "../../src/ui/tree/emptyComparison";

suite("empty comparison explanation", () => {
  test("names the direction that makes branch-changes mode legitimately empty", () => {
    const result = createResult({ aheadCount: 0, behindCount: 4, mode: "branchChanges" });

    const { cause, remedy } = emptyComparisonExplanation(result);

    assert.match(cause, /every commit of testbranch is already part of master/u);
    assert.ok(remedy, "a recoverable empty result must offer a way forward");
    assert.match(remedy, /Swap base and target to see what master adds/u);
    assert.match(remedy, /tip-to-tip/u);
    assert.equal(emptyComparisonDescription(result), "testbranch has no commits of its own");
  });

  test("reports identical endpoints without suggesting a different direction", () => {
    const result = createResult({ aheadCount: 0, behindCount: 0, mode: "branchChanges" });

    const { cause, remedy } = emptyComparisonExplanation(result);

    assert.match(cause, /point at the same commit/u);
    assert.equal(remedy, undefined, "swapping identical endpoints cannot reveal changes");
    assert.equal(emptyComparisonDescription(result), "branches point at the same commit");
  });

  test("keeps tip-to-tip results direction-neutral", () => {
    const result = createResult({ aheadCount: 0, behindCount: 3, mode: "tipToTip" });

    const { cause, remedy } = emptyComparisonExplanation(result);

    assert.match(cause, /trees of master and testbranch are identical/u);
    assert.equal(remedy, undefined, "tip-to-tip already compares both directions");
    assert.equal(emptyComparisonDescription(result), "no differences");
  });

  test("explains a diverged target that only removed the base's own commits", () => {
    const result = createResult({ aheadCount: 2, behindCount: 2, mode: "branchChanges" });

    assert.match(emptyComparisonExplanation(result).cause, /identical for this comparison mode/u);
    assert.equal(emptyComparisonDescription(result), "no differences");
  });
});

interface ResultOverrides {
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly mode: SavedComparisonV1["mode"];
}

function createResult(overrides: ResultOverrides): ComparisonResult {
  return {
    aheadCommits: [],
    aheadCount: overrides.aheadCount,
    baseSha: "a".repeat(40),
    behindCommits: [],
    behindCount: overrides.behindCount,
    comparison: createComparison(overrides.mode),
    computedAt: 100,
    files: [],
    fromSha: "a".repeat(40),
    targetSha: "b".repeat(40),
    toSha: "b".repeat(40),
  };
}

function createComparison(mode: SavedComparisonV1["mode"]): SavedComparisonV1 {
  return {
    baseRef: { displayName: "master", fullName: "refs/heads/master", kind: "localBranch" },
    createdAt: 100,
    id: "comparison",
    mode,
    order: 0,
    pinned: false,
    repository: {
      label: "vscode-ref-haven",
      relativeRepositoryPath: ".",
      rootPath: "P:/Projects/vscode-ref-haven",
      workspaceFolderUri: "file:///p%3A/Projects/vscode-ref-haven",
    },
    schemaVersion: 1,
    targetRef: {
      displayName: "testbranch",
      fullName: "refs/heads/testbranch",
      kind: "localBranch",
    },
    updatedAt: 100,
  };
}
