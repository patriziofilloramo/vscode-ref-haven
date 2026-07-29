import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as vscode from "vscode";

import {
  blameLine,
  listWorkingTreeChanges,
  listWorkingTreeFileChanges,
  searchCommits,
} from "../../src/infrastructure/git/GitCli";
import { UnsupportedContentFilterError } from "../../src/infrastructure/git/contentFilterGuard";

suite("Git executable-driver isolation", () => {
  test("does not execute configured content filters or textconv commands", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const repositoryRoot = workspaceFolder.uri.fsPath;
    const fixturePath = join(repositoryRoot, "fixture.txt");
    const plainPath = join(repositoryRoot, "nested", "deleted.txt");
    const attributesPath = join(repositoryRoot, ".gitattributes");
    const scriptPath = join(repositoryRoot, "refhaven-filter-marker.cjs");
    const markerPath = join(repositoryRoot, "refhaven-filter-ran.txt");
    const originalFixture = readFileSync(fixturePath);
    const originalPlain = readFileSync(plainPath);
    const driver = "refhaven-security-marker";
    const filterCommand = `node ${shellQuote(scriptPath)} ${shellQuote(markerPath)}`;

    try {
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
      writeFileSync(
        fixturePath,
        `${originalFixture.toString("utf8")}working tree change\n`,
        "utf8",
      );
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

      writeFileSync(plainPath, `${originalPlain.toString("utf8")}plain change\n`, "utf8");
      const plainChanges = await listWorkingTreeFileChanges(
        repositoryRoot,
        headSha,
        "nested/deleted.txt",
      );
      assert.ok(plainChanges.length > 0, "configured drivers must not block unfiltered paths");
      assert.equal(existsSync(markerPath), false, "an unrelated path executed a content filter");

      const commits = await searchCommits(repositoryRoot, "content", "tracked fixture line");
      assert.ok(commits.length > 0);
      assert.equal(existsSync(markerPath), false, "content search executed a textconv command");
    } finally {
      unsetLocalConfig(repositoryRoot, `filter.${driver}.clean`);
      unsetLocalConfig(repositoryRoot, `filter.${driver}.required`);
      unsetLocalConfig(repositoryRoot, `diff.${driver}.textconv`);
      writeFileSync(fixturePath, originalFixture);
      writeFileSync(plainPath, originalPlain);
      for (const path of [attributesPath, scriptPath, markerPath]) {
        rmSync(path, { force: true });
      }
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

function unsetLocalConfig(repositoryRoot: string, key: string): void {
  try {
    git(repositoryRoot, "config", "--local", "--unset-all", key);
  } catch {
    // Best-effort cleanup in the isolated extension-test repository.
  }
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("\\", "/").replaceAll("'", `'\\''`)}'`;
}
