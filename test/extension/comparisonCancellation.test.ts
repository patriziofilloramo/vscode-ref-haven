import assert from "node:assert/strict";
import { resolve } from "node:path";

import * as vscode from "vscode";

import type { SavedComparisonV1 } from "../../src/domain/comparison";
import type { ComparisonResult } from "../../src/domain/comparisonResult";
import { ComparisonTreeProvider } from "../../src/ui/tree/ComparisonTreeProvider";
import { BranchesTreeProvider } from "../../src/ui/tree/BranchesTreeProvider";
import { CommitDetailsTreeProvider } from "../../src/ui/tree/CommitDetailsTreeProvider";
import { FileHistoryTreeProvider } from "../../src/ui/tree/FileHistoryTreeProvider";
import { InspectorTreeProvider } from "../../src/ui/tree/InspectorTreeProvider";
import { RepositoryTreeProvider } from "../../src/ui/tree/RepositoryTreeProvider";
import { WorktreesTreeProvider } from "../../src/ui/tree/WorktreesTreeProvider";

suite("comparison tree lifecycle", () => {
  test("exposes the exact root node used by the tree for reveal", async () => {
    const provider = new ComparisonTreeProvider();
    const comparison = createComparison();
    provider.setComparisons([comparison]);

    try {
      const [rootNode] = await provider.getChildren();
      assert.ok(rootNode);
      assert.strictEqual(provider.getComparisonNode(comparison.id), rootNode);
    } finally {
      provider.dispose();
    }
  });

  test("resolves reveal parents back to the tree roots", async () => {
    const provider = new ComparisonTreeProvider();
    const comparison = createComparison();
    const commit = {
      authorDate: 1,
      authorName: "Author",
      sha: "3".repeat(40),
      subject: "feat: add fixture",
    };
    provider.setComparisons([comparison]);
    provider.setComparisonLoader(() =>
      Promise.resolve(createResult(comparison, { aheadCommits: [commit], aheadCount: 1 })),
    );

    try {
      const rootNode = provider.getComparisonNode(comparison.id);
      assert.ok(rootNode);
      assert.equal(provider.getParent(rootNode), undefined);

      const children = await provider.getChildren(rootNode);
      const aheadSection = children.find(
        (child) => child.kind === "section" && child.section === "ahead",
      );
      assert.ok(aheadSection);
      assert.strictEqual(provider.getParent(aheadSection), rootNode);

      const [commitNode] = await provider.getChildren(aheadSection);
      assert.ok(commitNode?.kind === "commit");
      const commitParent = provider.getParent(commitNode);
      assert.ok(commitParent?.kind === "section");
      assert.equal(commitParent.section, "ahead");
    } finally {
      provider.dispose();
    }
  });

  test("prepares the comparison before the tree expands it", async () => {
    const provider = new ComparisonTreeProvider();
    const comparison = createComparison();
    let loadCount = 0;
    provider.setComparisons([comparison]);
    provider.setComparisonLoader(() => {
      loadCount += 1;
      return Promise.resolve(createResult(comparison));
    });

    try {
      await provider.prepareComparison(comparison.id);
      const node = provider.getComparisonNode(comparison.id);
      assert.ok(node);
      const children = await provider.getChildren(node);

      assert.equal(loadCount, 1);
      assert.deepEqual(
        children.map((child) => child.kind),
        ["section", "section", "section"],
      );
    } finally {
      provider.dispose();
    }
  });

  test("renders a requested comparison as expanded across refreshes", () => {
    const provider = new ComparisonTreeProvider();
    const comparison = createComparison();
    provider.setComparisons([comparison]);

    try {
      const node = provider.getComparisonNode(comparison.id);
      assert.ok(node);
      provider.requestComparisonExpansion(comparison.id);

      assert.equal(
        provider.getTreeItem(node).collapsibleState,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      provider.setComparisons([comparison]);
      const refreshedNode = provider.getComparisonNode(comparison.id);
      assert.ok(refreshedNode);
      assert.equal(
        provider.getTreeItem(refreshedNode).collapsibleState,
        vscode.TreeItemCollapsibleState.Expanded,
      );

      provider.clearComparisonExpansionRequest(comparison.id);
      assert.equal(
        provider.getTreeItem(refreshedNode).collapsibleState,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
    } finally {
      provider.dispose();
    }
  });

  test("shows loading, fresh, and stale state explicitly", async () => {
    const provider = new ComparisonTreeProvider();
    const comparison = createComparison();
    let complete: ((result: ComparisonResult) => void) | undefined;
    provider.setComparisons([comparison]);
    provider.setComparisonLoader(
      () =>
        new Promise<ComparisonResult>((resolveResult) => {
          complete = resolveResult;
        }),
    );

    try {
      const root = provider.getComparisonNode(comparison.id);
      assert.ok(root);
      const pending = provider.getChildren(root);
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
      assert.match(String(provider.getTreeItem(root).description), /Loading/u);

      complete?.(
        createResult(comparison, {
          computedAt: Date.now(),
          files: [{ additions: 1, deletions: 0, newPath: "pending.ts", status: "modified" }],
        }),
      );
      await pending;
      assert.match(String(provider.getTreeItem(root).description), /updated/u);

      provider.invalidateResult(comparison.id);
      assert.match(String(provider.getTreeItem(root).description), /Stale/u);
    } finally {
      provider.dispose();
    }
  });

  test("surfaces merge-conflict forecasts prominently and clean forecasts quietly", async () => {
    const provider = new ComparisonTreeProvider();
    const comparison = createComparison();
    provider.setComparisons([comparison]);
    provider.setComparisonLoader(() =>
      Promise.resolve(
        createResult(comparison, {
          mergePreview: { conflictedPaths: ["src/a.ts", "src/b.ts"], kind: "conflicts" },
        }),
      ),
    );

    try {
      const node = provider.getComparisonNode(comparison.id);
      assert.ok(node);
      await provider.getChildren(node);
      const conflictedItem = provider.getTreeItem(node);
      assert.match(String(conflictedItem.description), /⚠ 2 merge conflicts/u);
      const conflictedTooltip = conflictedItem.tooltip as vscode.MarkdownString;
      assert.match(conflictedTooltip.value, /Merge preview: merging .* conflicts in/u);
      assert.match(conflictedTooltip.value, /src\/a\\\.ts/u);

      provider.invalidateResult(comparison.id);
      provider.setComparisonLoader(() =>
        Promise.resolve(createResult(comparison, { mergePreview: { kind: "clean" } })),
      );
      await provider.getChildren(node);
      const cleanItem = provider.getTreeItem(node);
      assert.doesNotMatch(String(cleanItem.description), /merge/u);
      assert.match(
        (cleanItem.tooltip as vscode.MarkdownString).value,
        /Merge preview: .* merges cleanly into/u,
      );
    } finally {
      provider.dispose();
    }
  });

  test("renders review progress and filters comparison files without affecting other nodes", async () => {
    const provider = new ComparisonTreeProvider();
    const comparison = createComparison();
    provider.setComparisons([comparison]);
    provider.setFilesLayout("list");
    provider.setComparisonLoader(() =>
      Promise.resolve(
        createResult(comparison, {
          files: [
            { additions: 1, deletions: 0, newPath: "reviewed.ts", status: "modified" },
            { additions: 2, deletions: 1, newPath: "unreviewed.ts", status: "added" },
          ],
        }),
      ),
    );
    provider.setReviewStateProvider((result) => ({
      reviewedCount: 1,
      reviewedPaths: new Set(["reviewed.ts"]),
      revisionKey: "a".repeat(64),
      totalCount: result.files.length,
    }));

    try {
      const root = provider.getComparisonNode(comparison.id);
      assert.ok(root);
      const sections = await provider.getChildren(root);
      const filesSection = sections.find(
        (node) => node.kind === "section" && node.section === "files",
      );
      assert.ok(filesSection);
      assert.match(String(provider.getTreeItem(filesSection).description ?? ""), /1\/2 reviewed/u);

      const files = await provider.getChildren(filesSection);
      assert.deepEqual(
        files.map((node) => provider.getTreeItem(node).contextValue),
        ["refhaven.file.modified.reviewed", "refhaven.file.added.unreviewed"],
      );

      provider.setFileFilter("unreviewed");
      const unreviewed = await provider.getChildren(filesSection);
      assert.deepEqual(
        unreviewed.map((node) => provider.getTreeItem(node).label),
        ["unreviewed.ts"],
      );
    } finally {
      provider.dispose();
    }
  });

  test("resolves a comparison file and its full reveal parent chain", async () => {
    const provider = new ComparisonTreeProvider();
    const comparison = createComparison();
    provider.setComparisons([comparison]);
    provider.setComparisonLoader(() =>
      Promise.resolve(
        createResult(comparison, {
          files: [
            {
              additions: 3,
              deletions: 1,
              newPath: "src/application/controller.ts",
              status: "modified",
            },
          ],
        }),
      ),
    );

    try {
      const file = await provider.findComparisonFileNode(
        comparison.id,
        "src/application/controller.ts",
      );
      assert.ok(file);
      const folder = provider.getParent(file);
      assert.ok(folder?.kind === "folder");
      const filesSection = provider.getParent(folder);
      assert.ok(filesSection?.kind === "section");
      assert.equal(filesSection.section, "files");
      assert.strictEqual(
        provider.getParent(filesSection),
        provider.getComparisonNode(comparison.id),
      );
    } finally {
      provider.dispose();
    }
  });

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

suite("composite native views", () => {
  test("consolidates inspector and repository providers into four top-level sections", async () => {
    const fileHistory = new FileHistoryTreeProvider();
    const commitDetails = new CommitDetailsTreeProvider();
    const branches = new BranchesTreeProvider();
    const worktrees = new WorktreesTreeProvider();
    const inspector = new InspectorTreeProvider(fileHistory, commitDetails);
    const repository = new RepositoryTreeProvider(branches, worktrees);

    try {
      const inspectorSections = await inspector.getChildren();
      assert.deepEqual(
        inspectorSections.map((node) => inspector.getTreeItem(node).label),
        ["File History", "Commit Details"],
      );
      const repositorySections = await repository.getChildren();
      assert.deepEqual(
        repositorySections.map((node) => repository.getTreeItem(node).label),
        ["Branches", "Worktrees"],
      );
    } finally {
      inspector.dispose();
      repository.dispose();
      fileHistory.dispose();
      commitDetails.dispose();
      branches.dispose();
      worktrees.dispose();
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

function createResult(
  comparison: SavedComparisonV1,
  overrides: Partial<ComparisonResult> = {},
): ComparisonResult {
  const baseSha = "1".repeat(40);
  const targetSha = "2".repeat(40);
  return {
    aheadCommits: [],
    aheadCount: 0,
    baseSha,
    behindCommits: [],
    behindCount: 0,
    comparison,
    computedAt: 1,
    files: [],
    fromSha: baseSha,
    mergeBaseSha: baseSha,
    targetSha,
    toSha: targetSha,
    ...overrides,
  };
}
