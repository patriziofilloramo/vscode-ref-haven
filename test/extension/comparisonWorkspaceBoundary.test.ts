import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as vscode from "vscode";

import { ComparisonController } from "../../src/application/ComparisonController";
import type { Logger } from "../../src/application/Logger";
import type { ComparisonReviewStore } from "../../src/application/ComparisonReviewStore";
import type { ComparisonStore } from "../../src/application/ComparisonStore";
import type { RepositoryIdentity, SavedComparisonV1 } from "../../src/domain/comparison";
import type { ComparisonReviewSummary } from "../../src/domain/comparisonReview";
import type { ComparisonResult } from "../../src/domain/comparisonResult";
import type { GitRevisionContentProvider } from "../../src/ui/documents/GitRevisionContentProvider";
import {
  ComparisonTreeProvider,
  type ComparisonTreeNode,
} from "../../src/ui/tree/ComparisonTreeProvider";

suite("comparison workspace boundary", () => {
  test("hides unavailable persisted comparisons without deleting their data", async () => {
    const workspaceRepository = currentWorkspaceRepository();
    const outsideRepository = createRepository(join(tmpdir(), "refhaven-stored-outside"));
    const inside = createComparison("inside-workspace", workspaceRepository, 0);
    const outside = createComparison("outside-workspace", outsideRepository, 1);
    const comparisons = [inside, outside];
    let repositories: readonly RepositoryIdentity[] = [workspaceRepository];
    let prunedIds: ReadonlySet<string> | undefined;
    const harness = createHarness(
      comparisons,
      () => Promise.resolve(repositories),
      (ids) => {
        prunedIds = new Set(ids);
      },
    );

    try {
      harness.controller.initialize();
      assert.deepEqual(await rootComparisonIds(harness.provider), []);

      await harness.controller.refreshAvailableComparisons();
      assert.deepEqual(await rootComparisonIds(harness.provider), [inside.id]);
      assert.deepEqual(
        [...(prunedIds ?? [])].sort(),
        [inside.id, outside.id].sort(),
        "review data is pruned against persisted IDs, not just visible comparisons",
      );
      assert.deepEqual(
        comparisons.map(({ id }) => id),
        [inside.id, outside.id],
        "filtering the view must not mutate persisted comparisons",
      );

      repositories = [];
      const refresh = harness.controller.refreshAvailableComparisons();
      assert.deepEqual(
        await rootComparisonIds(harness.provider),
        [],
        "stale roots are hidden before asynchronous repository discovery completes",
      );
      await refresh;
      assert.deepEqual(await rootComparisonIds(harness.provider), []);

      repositories = [workspaceRepository];
      await harness.controller.refreshAvailableComparisons();
      assert.deepEqual(await rootComparisonIds(harness.provider), [inside.id]);
    } finally {
      harness.provider.dispose();
    }
  });

  test("rejects calculations and cached actions after a repository leaves the workspace", async () => {
    const workspaceRepository = currentWorkspaceRepository();
    const outsideRepository = createRepository(join(tmpdir(), "refhaven-action-outside"));
    const outside = createComparison("outside-action", outsideRepository, 0);
    let comparisonLoadCount = 0;
    let revisionPrepareCount = 0;
    const harness = createHarness(
      [outside],
      () => Promise.resolve([workspaceRepository]),
      undefined,
      {
        prepareTextDiff: () => {
          revisionPrepareCount += 1;
          return Promise.resolve();
        },
      },
    );
    harness.provider.setComparisons([outside]);
    harness.provider.setComparisonLoader(() => {
      comparisonLoadCount += 1;
      return Promise.resolve(createResult(outside));
    });

    try {
      await assert.rejects(
        harness.controller.calculateComparison(outside),
        /not part of the current workspace/u,
      );
      await assert.rejects(
        harness.controller.openAllComparisonChanges(outside),
        /not part of the current workspace/u,
      );
      assert.equal(comparisonLoadCount, 0, "cached results must not bypass the workspace check");

      await assert.rejects(
        harness.controller.openFileDiff(
          {
            fromSha: "1".repeat(40),
            label: "outside comparison",
            repositoryRootPath: outsideRepository.rootPath,
            toSha: "2".repeat(40),
          },
          { additions: 1, deletions: 0, newPath: "outside.txt", status: "modified" },
        ),
        /not part of the current workspace/u,
      );
      assert.equal(revisionPrepareCount, 0, "revision reads must not start outside the workspace");
    } finally {
      harness.provider.dispose();
    }
  });

  test("preserves cached results during a non-clearing topology refresh", async () => {
    const workspaceRepository = currentWorkspaceRepository();
    const comparison = createComparison("unchanged-topology", workspaceRepository, 0);
    const harness = createHarness([comparison], () => Promise.resolve([workspaceRepository]));
    let comparisonLoadCount = 0;
    harness.provider.setComparisonLoader(() => {
      comparisonLoadCount += 1;
      return Promise.resolve(createResult(comparison));
    });

    try {
      harness.controller.initialize();
      await harness.controller.refreshAvailableComparisons();
      await harness.provider.loadComparisonResult(comparison.id);

      await harness.controller.refreshAvailableComparisons(false);
      await harness.provider.loadComparisonResult(comparison.id);

      assert.equal(comparisonLoadCount, 1, "an unchanged topology must retain cached results");
    } finally {
      harness.provider.dispose();
    }
  });

  test("ignores an older repository refresh that completes out of order", async () => {
    const workspaceRepository = currentWorkspaceRepository();
    const outsideRepository = createRepository(join(tmpdir(), "refhaven-stale-refresh"));
    const inside = createComparison("current-refresh", workspaceRepository, 0);
    const outside = createComparison("stale-refresh", outsideRepository, 1);
    let completeFirst: ((repositories: readonly RepositoryIdentity[]) => void) | undefined;
    let discoveryCount = 0;
    const harness = createHarness([inside, outside], () => {
      discoveryCount += 1;
      if (discoveryCount === 1) {
        return new Promise((resolveRepositories) => {
          completeFirst = resolveRepositories;
        });
      }
      return Promise.resolve([workspaceRepository]);
    });

    try {
      const staleRefresh = harness.controller.refreshAvailableComparisons();
      await harness.controller.refreshAvailableComparisons();
      completeFirst?.([outsideRepository]);
      await staleRefresh;

      assert.deepEqual(await rootComparisonIds(harness.provider), [inside.id]);
    } finally {
      harness.provider.dispose();
    }
  });

  test("rejects an action whose repository check races with a workspace refresh", async () => {
    const workspaceRepository = currentWorkspaceRepository();
    const comparison = createComparison("racing-action", workspaceRepository, 0);
    let completeActionDiscovery:
      ((repositories: readonly RepositoryIdentity[]) => void) | undefined;
    let discoveryCount = 0;
    let comparisonLoadCount = 0;
    const harness = createHarness([comparison], () => {
      discoveryCount += 1;
      if (discoveryCount === 1) {
        return new Promise((resolveRepositories) => {
          completeActionDiscovery = resolveRepositories;
        });
      }
      return Promise.resolve([]);
    });
    harness.provider.setComparisons([comparison]);
    harness.provider.setComparisonLoader(() => {
      comparisonLoadCount += 1;
      return Promise.resolve(createResult(comparison));
    });

    try {
      const action = harness.controller.openAllComparisonChanges(comparison);
      await harness.controller.refreshAvailableComparisons();
      completeActionDiscovery?.([workspaceRepository]);

      await assert.rejects(action, /workspace changed/u);
      assert.equal(comparisonLoadCount, 0);
    } finally {
      harness.provider.dispose();
    }
  });
});

function createHarness(
  comparisons: readonly SavedComparisonV1[],
  repositoryDiscovery: () => Promise<readonly RepositoryIdentity[]>,
  onPrune?: (comparisonIds: ReadonlySet<string>) => void,
  revisionOverrides: Partial<GitRevisionContentProvider> = {},
): {
  readonly controller: ComparisonController;
  readonly provider: ComparisonTreeProvider;
} {
  const provider = new ComparisonTreeProvider();
  const store = {
    getAll: () => [...comparisons],
  } as unknown as ComparisonStore;
  const reviewStore = {
    getSummary: (result: ComparisonResult): ComparisonReviewSummary => ({
      reviewedCount: 0,
      reviewedPaths: new Set<string>(),
      revisionKey: "review-revision",
      totalCount: result.files.length,
    }),
    prune: (comparisonIds: ReadonlySet<string>) => {
      onPrune?.(comparisonIds);
      return Promise.resolve();
    },
  } as unknown as ComparisonReviewStore;
  const revisionProvider = {
    ...revisionOverrides,
  } as unknown as GitRevisionContentProvider;
  const context = {
    workspaceState: {
      get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
      update: () => Promise.resolve(),
    },
  } as unknown as vscode.ExtensionContext;
  const treeView = { selection: [] } as unknown as vscode.TreeView<ComparisonTreeNode>;
  const logger: Logger = {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
  const controller = new ComparisonController(
    context,
    store,
    provider,
    treeView,
    logger,
    revisionProvider,
    reviewStore,
    repositoryDiscovery,
  );
  return { controller, provider };
}

async function rootComparisonIds(provider: ComparisonTreeProvider): Promise<readonly string[]> {
  return (await provider.getChildren()).flatMap((node) =>
    node.kind === "comparison" ? [node.comparison.id] : [],
  );
}

function currentWorkspaceRepository(): RepositoryIdentity {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder);
  return {
    label: workspaceFolder.name,
    relativeRepositoryPath: ".",
    rootPath: workspaceFolder.uri.fsPath,
    workspaceFolderUri: workspaceFolder.uri.toString(),
  };
}

function createRepository(rootPath: string): RepositoryIdentity {
  return {
    label: "outside",
    relativeRepositoryPath: ".",
    rootPath,
    workspaceFolderUri: vscode.Uri.file(rootPath).toString(),
  };
}

function createComparison(
  id: string,
  repository: RepositoryIdentity,
  order: number,
): SavedComparisonV1 {
  return {
    baseRef: { displayName: "main", fullName: "refs/heads/main", kind: "localBranch" },
    createdAt: 1,
    id,
    mode: "branchChanges",
    order,
    pinned: false,
    repository,
    schemaVersion: 1,
    targetRef: {
      displayName: "feature",
      fullName: "refs/heads/feature",
      kind: "localBranch",
    },
    updatedAt: 1,
  };
}

function createResult(comparison: SavedComparisonV1): ComparisonResult {
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
  };
}
