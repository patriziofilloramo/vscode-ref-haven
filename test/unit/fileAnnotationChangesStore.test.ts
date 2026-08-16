import assert from "node:assert/strict";

import type * as vscode from "vscode";

import {
  FileAnnotationChangesStore,
  isSavedChangesAnnotation,
} from "../../src/application/FileAnnotationChangesStore";
import { CHANGES_ANNOTATION_STORAGE_KEY } from "../../src/domain/fileAnnotations";

suite("FileAnnotationChangesStore", () => {
  const selection = {
    baseRef: { displayName: "main", fullName: "refs/heads/main", kind: "localBranch" },
    repositoryRoot: process.platform === "win32" ? "C:\\workspace\\repo" : "/workspace/repo",
    schemaVersion: 1,
  } as const;

  test("accepts only a complete workspace-local baseline", () => {
    assert.equal(isSavedChangesAnnotation(selection), true);
    assert.equal(isSavedChangesAnnotation({ ...selection, schemaVersion: 2 }), false);
    assert.equal(
      isSavedChangesAnnotation({ ...selection, repositoryRoot: "relative/repo" }),
      false,
    );
    assert.equal(
      isSavedChangesAnnotation({
        ...selection,
        baseRef: { ...selection.baseRef, fullName: "refs/heads/../unsafe" },
      }),
      false,
    );
    assert.equal(
      isSavedChangesAnnotation({ ...selection, repositoryRoot: `/${"r".repeat(32_768)}` }),
      false,
    );
    assert.equal(
      isSavedChangesAnnotation({
        ...selection,
        baseRef: { ...selection.baseRef, displayName: "r".repeat(513) },
      }),
      false,
    );
    assert.equal(
      isSavedChangesAnnotation({
        ...selection,
        baseRef: { displayName: "Working Tree", fullName: "WORKTREE", kind: "workingTree" },
      }),
      false,
    );
  });

  test("loads validated state and serializes save then clear", async () => {
    const state = new TestWorkspaceState(selection);
    const store = new FileAnnotationChangesStore(state.asWorkspaceState());
    assert.deepEqual(store.get(), selection);

    const replacement = {
      ...selection,
      baseRef: { displayName: "v1", fullName: "refs/tags/v1", kind: "tag" },
    } as const;
    await Promise.all([store.set(replacement), store.set(undefined)]);
    assert.equal(store.get(), undefined);
    assert.equal(state.updateCount, 2);
  });

  test("rejects malformed state on load and write", async () => {
    const state = new TestWorkspaceState({ ...selection, repositoryRoot: "relative" });
    const store = new FileAnnotationChangesStore(state.asWorkspaceState());
    assert.equal(store.get(), undefined);
    await assert.rejects(
      store.set({ ...selection, repositoryRoot: "relative" }),
      /baseline is invalid/u,
    );
  });

  test("continues serialized writes after a persistence failure", async () => {
    const state = new TestWorkspaceState(undefined);
    const store = new FileAnnotationChangesStore(state.asWorkspaceState());
    state.rejectNextUpdate();
    await assert.rejects(store.set(selection), /persistence failed/u);
    await store.set(selection);
    assert.deepEqual(store.get(), selection);
  });
});

class TestWorkspaceState {
  private failNextUpdate = false;
  public updateCount = 0;
  private value: unknown;

  public constructor(value: unknown) {
    this.value = value;
  }

  public get(key: string): unknown {
    assert.equal(key, CHANGES_ANNOTATION_STORAGE_KEY);
    return this.value;
  }

  public async update(key: string, value: unknown): Promise<void> {
    assert.equal(key, CHANGES_ANNOTATION_STORAGE_KEY);
    await new Promise<void>((resolveUpdate) => setImmediate(resolveUpdate));
    this.updateCount += 1;
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("persistence failed");
    }
    this.value = value;
  }

  public rejectNextUpdate(): void {
    this.failNextUpdate = true;
  }

  public asWorkspaceState(): Pick<vscode.ExtensionContext["workspaceState"], "get" | "update"> {
    return this as Pick<vscode.ExtensionContext["workspaceState"], "get" | "update">;
  }
}
