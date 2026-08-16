import assert from "node:assert/strict";
import { resolve } from "node:path";

import type { SavedComparisonV1 } from "../../src/domain/comparison";
import { isGitObjectId } from "../../src/domain/gitObjectId";
import {
  isFileChange,
  isFileDiffScope,
  isLineBlameActionTarget,
  isSavedComparisonV1,
} from "../../src/domain/validation";

const SHA = "a".repeat(40);

suite("domain boundary validation", () => {
  test("accepts only complete SHA-1 and SHA-256 object IDs", () => {
    assert.equal(isGitObjectId("a".repeat(40)), true);
    assert.equal(isGitObjectId("b".repeat(64)), true);
    assert.equal(isGitObjectId("a".repeat(39)), false);
    assert.equal(isGitObjectId("a".repeat(41)), false);
    assert.equal(isGitObjectId("b".repeat(63)), false);
    assert.equal(isGitObjectId("b".repeat(65)), false);
  });

  test("accepts a complete saved comparison", () => {
    assert.equal(isSavedComparisonV1(createComparison()), true);
    assert.equal(
      isSavedComparisonV1({
        ...createComparison(),
        mode: "workingTree",
        targetRef: { displayName: "Working Tree", fullName: "WORKTREE", kind: "workingTree" },
      }),
      true,
    );
    assert.equal(
      isSavedComparisonV1({
        ...createComparison(),
        targetRef: { displayName: "v1", fullName: "refs/tags/v1", kind: "tag" },
      }),
      true,
    );
  });

  test("rejects invalid modes, refs, roots, timestamps, and ordering", () => {
    const valid = createComparison();
    const invalid: unknown[] = [
      { ...valid, mode: "unknown" },
      { ...valid, createdAt: Number.NaN },
      { ...valid, order: -1 },
      { ...valid, repository: { ...valid.repository, rootPath: "relative/repository" } },
      { ...valid, baseRef: { ...valid.baseRef, fullName: "HEAD" } },
      { ...valid, targetRef: { ...valid.targetRef, fullName: "refs/heads/../secret" } },
      { ...valid, targetRef: { ...valid.targetRef, fullName: "refs/heads/feature.lock" } },
      { ...valid, targetRef: { ...valid.targetRef, fullName: "refs/heads//feature" } },
      { ...valid, customLabel: "" },
      { ...valid, customLabel: " padded" },
      { ...valid, customLabel: "line\nbreak" },
      { ...valid, customLabel: "hidden\u202econtrol" },
      { ...valid, customLabel: "x".repeat(101) },
      {
        ...valid,
        mode: "workingTree",
        targetRef: { displayName: "feature", fullName: "refs/heads/feature", kind: "localBranch" },
      },
    ];
    for (const candidate of invalid) assert.equal(isSavedComparisonV1(candidate), false);
    assert.equal(isSavedComparisonV1({ ...valid, customLabel: "Release 🚀" }), true);
  });

  test("rejects file changes and scopes that can escape their repository", () => {
    assert.equal(isFileChange({ newPath: "../outside.txt", status: "modified" }), false);
    assert.equal(isFileChange({ newPath: "aux.c", status: "modified" }), true);
    assert.equal(isFileChange({ newPath: "..\\outside.txt", status: "modified" }), true);
    assert.equal(isFileChange({ newPath: "safe.txt", oldPath: 42, status: "renamed" }), false);
    assert.equal(
      isFileDiffScope({
        fromSha: null,
        label: "test",
        repositoryRootPath: "relative",
        toSha: SHA,
      }),
      false,
    );
  });

  test("accepts only complete repository-local line blame action targets", () => {
    const valid = {
      filePath: "src/example.ts",
      lineNumber: 12,
      repositoryRoot: resolve("repository"),
      revisionLineNumber: 8,
      revisionPath: "src/old-example.ts",
      sha: SHA,
    };
    assert.equal(isLineBlameActionTarget(valid), true);
    for (const candidate of [
      { ...valid, repositoryRoot: "relative" },
      { ...valid, filePath: "../outside.ts" },
      { ...valid, revisionPath: "/absolute.ts" },
      { ...valid, lineNumber: 0 },
      { ...valid, revisionLineNumber: 1.5 },
      { ...valid, sha: "a".repeat(39) },
    ]) {
      assert.equal(isLineBlameActionTarget(candidate), false);
    }
  });
});

function createComparison(): SavedComparisonV1 {
  return {
    baseRef: { displayName: "main", fullName: "refs/heads/main", kind: "localBranch" },
    createdAt: 1,
    id: "comparison-1",
    mode: "branchChanges",
    order: 0,
    pinned: false,
    repository: {
      label: "repository",
      relativeRepositoryPath: ".",
      rootPath: resolve("repository"),
      workspaceFolderUri: "file:///workspace",
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
