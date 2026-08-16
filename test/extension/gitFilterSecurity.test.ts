import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  blameLine,
  listWorkingTreeChanges,
  listWorkingTreeFileChanges,
  searchCommits,
} from "../../src/infrastructure/git/GitCli";
import { UnsupportedContentFilterError } from "../../src/infrastructure/git/contentFilterGuard";

suite("Git executable-driver isolation", () => {
  test("does not execute configured content filters or textconv commands", async () => {
    // This repository must stay outside the opened workspace: VS Code's built-in
    // Git extension is allowed to execute user-configured filters while polling
    // an observed worktree, which would make RefHaven's isolation test racy.
    const repositoryRoot = mkdtempSync(join(tmpdir(), "refhaven-filter-security-"));
    const fixturePath = join(repositoryRoot, "fixture.txt");
    const plainPath = join(repositoryRoot, "nested", "deleted.txt");
    const attributesPath = join(repositoryRoot, ".gitattributes");
    const scriptPath = join(repositoryRoot, "refhaven-filter-marker.cjs");
    const markerPath = join(repositoryRoot, "refhaven-filter-ran.txt");
    const driver = "refhaven-security-marker";
    const filterCommand = `node ${shellQuote(scriptPath)} ${shellQuote(markerPath)}`;

    try {
      mkdirSync(join(repositoryRoot, "nested"));
      writeFileSync(fixturePath, "tracked fixture line\n", "utf8");
      writeFileSync(plainPath, "plain tracked line\n", "utf8");
      git(repositoryRoot, "init");
      git(repositoryRoot, "config", "user.name", "RefHaven Tests");
      git(repositoryRoot, "config", "user.email", "refhaven@example.invalid");
      git(repositoryRoot, "add", "--", "fixture.txt", "nested/deleted.txt");
      git(repositoryRoot, "commit", "-m", "fixture");

      writeFileSync(
        scriptPath,
        [
          'const { writeFileSync } = require("node:fs");',
          'writeFileSync(process.argv[2], "executed\\n", "utf8");',
          "process.stdin.pipe(process.stdout);",
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(attributesPath, `fixture.txt filter=${driver} diff=${driver}\n`, "utf8");
      writeFileSync(fixturePath, "tracked fixture line\nworking tree change\n", "utf8");
      git(repositoryRoot, "config", "--local", `filter.${driver}.clean`, filterCommand);
      git(repositoryRoot, "config", "--local", `filter.${driver}.required`, "true");
      git(repositoryRoot, "config", "--local", `diff.${driver}.textconv`, filterCommand);
      const headSha = git(repositoryRoot, "rev-parse", "HEAD").trim();

      await assert.rejects(
        listWorkingTreeFileChanges(repositoryRoot, headSha, "fixture.txt"),
        UnsupportedContentFilterError,
      );
      assert.equal(existsSync(markerPath), false, "working-tree diff executed a content filter");

      await assert.rejects(
        blameLine(repositoryRoot, "fixture.txt", 1),
        UnsupportedContentFilterError,
      );
      assert.equal(existsSync(markerPath), false, "worktree blame executed a content filter");

      await assert.rejects(
        listWorkingTreeChanges(repositoryRoot, headSha),
        UnsupportedContentFilterError,
      );
      assert.equal(existsSync(markerPath), false, "whole-tree diff executed a content filter");

      writeFileSync(plainPath, "plain tracked line\nplain change\n", "utf8");
      const plainChanges = await listWorkingTreeFileChanges(
        repositoryRoot,
        headSha,
        "nested/deleted.txt",
      );
      assert.ok(plainChanges.length > 0, "configured drivers must not block unfiltered paths");
      assert.equal(existsSync(markerPath), false, "an unrelated path executed a content filter");

      const commits = await searchCommits(repositoryRoot, {
        caseSensitive: true,
        kind: "content",
        patternMode: "literal",
        text: "tracked fixture line",
      });
      assert.ok(commits.length > 0);
      assert.equal(existsSync(markerPath), false, "content search executed a textconv command");
    } finally {
      removeTemporaryRepository(repositoryRoot);
    }
  });
});

function git(repositoryRoot: string, ...args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("\\", "/").replaceAll("'", `'\\''`)}'`;
}

function removeTemporaryRepository(repositoryRoot: string): void {
  const resolvedRoot = resolve(repositoryRoot);
  if (
    dirname(resolvedRoot) !== resolve(tmpdir()) ||
    !basename(resolvedRoot).startsWith("refhaven-filter-security-")
  ) {
    throw new Error("Refusing to remove an unexpected test repository path.");
  }
  try {
    removeTree(resolvedRoot);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    if (!existsSync(resolvedRoot)) return;
    makeTreeWritable(resolvedRoot);
    removeTree(resolvedRoot);
  }
}

function removeTree(path: string): void {
  rmSync(path, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
}

function makeTreeWritable(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) makeTreeWritable(entryPath);
    else chmodSync(entryPath, 0o600);
  }
  chmodSync(path, 0o700);
}
