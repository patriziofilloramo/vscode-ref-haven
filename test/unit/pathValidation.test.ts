import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  assertRepositoryWorktreeGitPath,
  isRepositoryRelativeGitPath,
  resolvePathWithinRepository,
} from "../../src/domain/pathValidation";

suite("repository path validation", () => {
  test("accepts canonical Git paths", () => {
    assert.equal(isRepositoryRelativeGitPath("src/application/file name.ts"), true);
    assert.equal(isRepositoryRelativeGitPath("Unicode/è.txt"), true);
  });

  test("rejects absolute, traversal, ambiguous, and cross-platform paths", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "../outside.txt",
      "folder/../outside.txt",
      "folder/./file.txt",
      "folder//file.txt",
      "..\\outside.txt",
      "folder\\file.txt",
      "nul\0byte",
    ]) {
      assert.equal(isRepositoryRelativeGitPath(path), false, path);
    }
  });

  test("resolves valid paths below an absolute repository root", () => {
    const root = resolve("repository");
    assert.equal(resolvePathWithinRepository(root, "src/file.ts"), resolve(root, "src", "file.ts"));
    assert.throws(() => resolvePathWithinRepository(root, "..\\outside.txt"), /invalid/i);
  });

  test("rejects repository metadata for worktree mutations", () => {
    assert.doesNotThrow(() => assertRepositoryWorktreeGitPath(".gitignore"));
    assert.doesNotThrow(() => assertRepositoryWorktreeGitPath("nested/.git/config"));
    assert.throws(() => assertRepositoryWorktreeGitPath(".git/config"), /metadata/i);
    assert.throws(() => assertRepositoryWorktreeGitPath(".GIT/config"), /metadata/i);
  });
});
