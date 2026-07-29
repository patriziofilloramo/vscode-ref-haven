import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  assertRepositoryWorktreeGitPath,
  isRepositoryRelativeGitPath,
  isRepositoryWorktreeGitPath,
  resolvePathWithinRepository,
} from "../../src/domain/pathValidation";

suite("repository path validation", () => {
  test("accepts canonical Git paths", () => {
    assert.equal(isRepositoryRelativeGitPath("src/application/file name.ts"), true);
    assert.equal(isRepositoryRelativeGitPath("Unicode/è.txt"), true);
  });

  test("rejects absolute, traversal, and ambiguous paths on every host", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "../outside.txt",
      "folder/../outside.txt",
      "folder/./file.txt",
      "folder//file.txt",
      "nul\0byte",
    ]) {
      assert.equal(isRepositoryRelativeGitPath(path), false, path);
    }
  });

  test("accepts host-incompatible names that can exist in immutable Git trees", () => {
    for (const path of [
      "C:/Windows/win.ini",
      "..\\outside.txt",
      "folder\\file.txt",
      "file.txt:alternate-stream",
      "folder/question?.txt",
      "folder/trailing.",
      "folder/trailing ",
      "NUL",
      "nul.txt",
      "folder/COM1.js",
      "folder/LPT¹.log",
    ]) {
      assert.equal(isRepositoryRelativeGitPath(path), true, path);
    }
    assert.equal(isRepositoryRelativeGitPath("folder/com10.txt"), true);
    assert.equal(isRepositoryRelativeGitPath("folder/auxiliary.txt"), true);
  });

  test("applies host filesystem restrictions only at the worktree boundary", () => {
    for (const path of [
      "C:/Windows/win.ini",
      "..\\outside.txt",
      "folder\\file.txt",
      "file.txt:alternate-stream",
      "folder/question?.txt",
      "folder/trailing.",
      "folder/trailing ",
      "NUL",
      "folder/COM1.js",
    ]) {
      assert.equal(isRepositoryWorktreeGitPath(path), process.platform !== "win32", path);
    }
  });

  test("resolves valid paths below an absolute repository root", () => {
    const root = resolve("repository");
    assert.equal(resolvePathWithinRepository(root, "src/file.ts"), resolve(root, "src", "file.ts"));
    if (process.platform === "win32") {
      for (const path of ["..\\outside.txt", "aux.c", "folder/trailing.", "folder/trailing "]) {
        assert.throws(() => resolvePathWithinRepository(root, path), /materialized/i, path);
      }
    } else {
      assert.equal(
        resolvePathWithinRepository(root, "..\\outside.txt"),
        resolve(root, "..\\outside.txt"),
      );
    }
  });

  test("rejects repository metadata for worktree mutations", () => {
    assert.doesNotThrow(() => assertRepositoryWorktreeGitPath(".gitignore"));
    assert.doesNotThrow(() => assertRepositoryWorktreeGitPath("nested/.git/config"));
    assert.equal(isRepositoryWorktreeGitPath(".git/config"), false);
    assert.throws(() => assertRepositoryWorktreeGitPath(".git/config"), /metadata/i);
    assert.throws(() => assertRepositoryWorktreeGitPath(".GIT/config"), /metadata/i);
    assert.throws(
      () => resolvePathWithinRepository(resolve("repository"), ".git/config"),
      /metadata/i,
    );
  });
});
