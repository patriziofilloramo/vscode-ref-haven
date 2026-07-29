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

  test("applies Windows filename restrictions only on Windows", () => {
    for (const path of [
      "C:/Windows/win.ini",
      "..\\outside.txt",
      "folder\\file.txt",
      "file.txt:alternate-stream",
      "folder/trailing.",
      "folder/trailing ",
      "NUL",
      "nul.txt",
      "folder/COM1.js",
      "folder/LPT¹.log",
    ]) {
      assert.equal(isRepositoryRelativeGitPath(path), process.platform !== "win32", path);
    }
    assert.equal(isRepositoryRelativeGitPath("folder/com10.txt"), true);
    assert.equal(isRepositoryRelativeGitPath("folder/auxiliary.txt"), true);
  });

  test("resolves valid paths below an absolute repository root", () => {
    const root = resolve("repository");
    assert.equal(resolvePathWithinRepository(root, "src/file.ts"), resolve(root, "src", "file.ts"));
    if (process.platform === "win32") {
      assert.throws(() => resolvePathWithinRepository(root, "..\\outside.txt"), /invalid/i);
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
    assert.throws(() => assertRepositoryWorktreeGitPath(".git/config"), /metadata/i);
    assert.throws(() => assertRepositoryWorktreeGitPath(".GIT/config"), /metadata/i);
  });
});
