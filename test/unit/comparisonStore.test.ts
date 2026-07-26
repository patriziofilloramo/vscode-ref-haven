import assert from "node:assert/strict";
import { resolve } from "node:path";

import { ComparisonStore } from "../../src/application/ComparisonStore";
import { COMPARISON_STORAGE_KEY, type SavedComparisonV1 } from "../../src/domain/comparison";

suite("ComparisonStore", () => {
  test("serializes concurrent updates without losing either change", async () => {
    const first = createComparison("first", 0);
    const second = createComparison("second", 1);
    const workspaceState = new DelayedWorkspaceState([first, second]);
    const store = new ComparisonStore(workspaceState);

    await Promise.all([
      store.replace(first.id, (comparison) => ({ ...comparison, pinned: true })),
      store.replace(second.id, (comparison) => ({ ...comparison, customLabel: "Renamed" })),
    ]);

    const stored = store.getAll();
    assert.equal(stored.find(({ id }) => id === first.id)?.pinned, true);
    assert.equal(stored.find(({ id }) => id === second.id)?.customLabel, "Renamed");
    assert.equal(workspaceState.updateCount, 2);
  });

  test("preserves concurrent additions and resolves order collisions", async () => {
    const workspaceState = new DelayedWorkspaceState([]);
    const store = new ComparisonStore(workspaceState);

    await Promise.all([
      store.add(createComparison("first", 0)),
      store.add(createComparison("second", 0)),
    ]);

    const stored = store.getAll();
    assert.deepEqual(stored.map(({ id }) => id).sort(), ["first", "second"]);
    assert.deepEqual(stored.map(({ order }) => order).sort(), [0, 1]);
  });

  test("continues processing after a persistence failure", async () => {
    const comparison = createComparison("first", 0);
    const workspaceState = new DelayedWorkspaceState([comparison]);
    const store = new ComparisonStore(workspaceState);
    workspaceState.rejectNextUpdate();

    await assert.rejects(
      store.replace(comparison.id, (current) => ({ ...current, pinned: true })),
      /persistence failed/u,
    );
    await store.replace(comparison.id, (current) => ({ ...current, customLabel: "Recovered" }));

    assert.equal(store.getAll()[0]?.pinned, false);
    assert.equal(store.getAll()[0]?.customLabel, "Recovered");
  });
});

class DelayedWorkspaceState {
  private failNextUpdate = false;
  private readonly values = new Map<string, unknown>();
  public updateCount = 0;

  public constructor(comparisons: readonly SavedComparisonV1[]) {
    this.values.set(COMPARISON_STORAGE_KEY, comparisons);
  }

  // Mirrors the generic one-argument overload exposed by vscode.Memento.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }

  public async update(key: string, value: unknown): Promise<void> {
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    this.updateCount += 1;
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("persistence failed");
    }
    this.values.set(key, value);
  }

  public rejectNextUpdate(): void {
    this.failNextUpdate = true;
  }
}

function createComparison(id: string, order: number): SavedComparisonV1 {
  return {
    baseRef: { displayName: "main", fullName: "refs/heads/main", kind: "localBranch" },
    createdAt: 1,
    id,
    mode: "branchChanges",
    order,
    pinned: false,
    repository: {
      label: "repository",
      relativeRepositoryPath: ".",
      rootPath: resolve("repository"),
      workspaceFolderUri: "file:///workspace",
    },
    schemaVersion: 1,
    targetRef: {
      displayName: id,
      fullName: `refs/heads/${id}`,
      kind: "localBranch",
    },
    updatedAt: 1,
  };
}
