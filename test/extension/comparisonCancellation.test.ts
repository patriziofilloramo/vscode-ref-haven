import assert from "node:assert/strict";
import { resolve } from "node:path";

import type { SavedComparisonV1 } from "../../src/domain/comparison";
import { ComparisonTreeProvider } from "../../src/ui/tree/ComparisonTreeProvider";

suite("comparison lifecycle cancellation", () => {
  test("aborts in-flight calculation when its comparison is removed", async () => {
    const provider = new ComparisonTreeProvider();
    const comparison = createComparison();
    let aborted = false;
    provider.setComparisons([comparison]);
    provider.setComparisonLoader(
      (_comparison, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              const error = new Error("cancelled");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );

    try {
      const pendingChildren = provider.getChildren({ comparison, kind: "comparison" });
      await new Promise((complete) => setImmediate(complete));
      provider.setComparisons([]);
      await pendingChildren;
      assert.equal(aborted, true);
    } finally {
      provider.dispose();
    }
  });
});

function createComparison(): SavedComparisonV1 {
  return {
    baseRef: { displayName: "main", fullName: "refs/heads/main", kind: "localBranch" },
    createdAt: 1,
    id: "cancellation-test",
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
}
