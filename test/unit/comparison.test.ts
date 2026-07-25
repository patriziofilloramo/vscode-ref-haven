import assert from "node:assert/strict";

import {
  deduplicateComparisons,
  hasSameComparisonIdentity,
  type SavedComparisonV1,
} from "../../src/domain/comparison";

suite("comparison identity", () => {
  test("treats repository, base, target, and mode as the logical identity", () => {
    const original = createComparison({ id: "first" });
    const duplicate = createComparison({
      createdAt: 200,
      id: "second",
      order: 3,
      rootPath: "P:/same-repository-with-a-different-runtime-path",
      updatedAt: 200,
    });

    assert.equal(hasSameComparisonIdentity(original, duplicate), true);
  });

  test("keeps directional and mode variants distinct", () => {
    const original = createComparison({ id: "original" });
    const swapped = createComparison({
      baseFullName: "refs/heads/testbranch",
      id: "swapped",
      targetFullName: "refs/heads/master",
    });
    const tipToTip = createComparison({ id: "tip-to-tip", mode: "tipToTip" });

    assert.equal(hasSameComparisonIdentity(original, swapped), false);
    assert.equal(hasSameComparisonIdentity(original, tipToTip), false);
  });

  test("removes persisted duplicates while preserving the first comparison", () => {
    const first = createComparison({ id: "first", order: 0 });
    const duplicate = createComparison({ id: "duplicate", order: 1 });
    const differentMode = createComparison({ id: "different-mode", mode: "tipToTip", order: 2 });

    const unique = deduplicateComparisons([first, duplicate, differentMode]);

    assert.deepEqual(
      unique.map(({ id }) => id),
      ["first", "different-mode"],
    );
  });
});

interface ComparisonOverrides {
  readonly baseFullName?: string;
  readonly createdAt?: number;
  readonly id: string;
  readonly mode?: SavedComparisonV1["mode"];
  readonly order?: number;
  readonly rootPath?: string;
  readonly targetFullName?: string;
  readonly updatedAt?: number;
}

function createComparison(overrides: ComparisonOverrides): SavedComparisonV1 {
  const baseFullName = overrides.baseFullName ?? "refs/heads/master";
  const targetFullName = overrides.targetFullName ?? "refs/heads/testbranch";
  return {
    baseRef: {
      displayName: baseFullName.replace("refs/heads/", ""),
      fullName: baseFullName,
      kind: "localBranch",
    },
    createdAt: overrides.createdAt ?? 100,
    id: overrides.id,
    mode: overrides.mode ?? "branchChanges",
    order: overrides.order ?? 0,
    pinned: false,
    repository: {
      label: "vscode-git-branch-compare",
      relativeRepositoryPath: ".",
      rootPath: overrides.rootPath ?? "P:/Projects/vscode-git-branch-compare",
      workspaceFolderUri: "file:///p%3A/Projects/vscode-git-branch-compare",
    },
    schemaVersion: 1,
    targetRef: {
      displayName: targetFullName.replace("refs/heads/", ""),
      fullName: targetFullName,
      kind: "localBranch",
    },
    updatedAt: overrides.updatedAt ?? 100,
  };
}
