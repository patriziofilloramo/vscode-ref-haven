import assert from "node:assert/strict";

import {
  comparisonLabel,
  deduplicateComparisons,
  hasSameComparisonIdentity,
  sortComparisonsForDisplay,
  withCustomLabel,
  withMode,
  withPinned,
  withSwappedRefs,
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

  test("removes duplicate persisted ids to protect tree and cache identity", () => {
    const first = createComparison({ id: "shared", order: 0 });
    const conflicting = createComparison({
      baseFullName: "refs/heads/other-base",
      id: "shared",
      order: 1,
    });
    assert.deepEqual(deduplicateComparisons([first, conflicting]), [first]);
  });
});

suite("comparison helpers", () => {
  test("withSwappedRefs swaps direction and bumps the update time", () => {
    const swapped = withSwappedRefs(createComparison({ id: "swap" }), 42);

    assert.equal(swapped.baseRef.fullName, "refs/heads/testbranch");
    assert.equal(swapped.targetRef.fullName, "refs/heads/master");
    assert.equal(swapped.updatedAt, 42);
  });

  test("withPinned updates the pinned flag", () => {
    assert.equal(withPinned(createComparison({ id: "pin" }), true, 42).pinned, true);
  });

  test("withCustomLabel sets, prefers, and clears the display name", () => {
    const base = createComparison({ id: "label" });
    assert.equal(comparisonLabel(base), "testbranch relative to master");

    const renamed = withCustomLabel(base, "Release audit", 42);
    assert.equal(renamed.customLabel, "Release audit");
    assert.equal(renamed.updatedAt, 42);
    assert.equal(comparisonLabel(renamed), "Release audit");

    const restored = withCustomLabel(renamed, undefined, 43);
    assert.equal("customLabel" in restored, false);
    assert.equal(restored.updatedAt, 43);
    assert.equal(comparisonLabel(restored), "testbranch relative to master");

    for (const invalid of ["", " padded", "line\nbreak", "hidden\u202econtrol", "x".repeat(101)]) {
      assert.throws(() => withCustomLabel(base, invalid, 44), /comparison name is invalid/u);
    }
    assert.equal(withCustomLabel(base, "Review 🚀", 45).customLabel, "Review 🚀");
  });

  test("withMode switches the diff mode and bumps the update time", () => {
    const changed = withMode(createComparison({ id: "mode" }), "tipToTip", 42);

    assert.equal(changed.mode, "tipToTip");
    assert.equal(changed.updatedAt, 42);
    assert.equal(withMode(changed, "branchChanges", 43).mode, "branchChanges");
  });

  test("sortComparisonsForDisplay lists pinned comparisons first, then by order", () => {
    const late = createComparison({ id: "late", order: 2 });
    const early = createComparison({ id: "early", mode: "tipToTip", order: 0 });
    const pinned = { ...createComparison({ id: "pinned", order: 1 }), pinned: true };

    const sorted = sortComparisonsForDisplay([late, early, pinned]);

    assert.deepEqual(
      sorted.map(({ id }) => id),
      ["pinned", "early", "late"],
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
      label: "vscode-git-refhaven",
      relativeRepositoryPath: ".",
      rootPath: overrides.rootPath ?? "P:/Projects/vscode-git-refhaven",
      workspaceFolderUri: "file:///p%3A/Projects/vscode-git-refhaven",
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
