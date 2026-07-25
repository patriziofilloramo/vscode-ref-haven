import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import { calculateComparison } from "../../src/application/ComparisonEngine";
import type { SavedComparisonV1 } from "../../src/domain/comparison";
import {
  blameFile,
  fileExistsAtRevision,
  listBranchDetails,
  listChangedLineRanges,
  listFileHistory,
  listGitRemoteUrls,
  listLineHistory,
  listRecentCommits,
  listWorkingTreeFileChanges,
  listWorktrees,
  readCommitDiffPreview,
  readCommitDetails,
  readWorktreeState,
  searchCommits,
} from "../../src/infrastructure/git/GitCli";
import { resolveFileContextTarget } from "../../src/ui/commands/fileContext";
import { ComparisonTreeProvider } from "../../src/ui/tree/ComparisonTreeProvider";

const EXTENSION_ID = "local-development.refhaven";

suite("native branch diff", () => {
  let repositoryRoot: string;

  suiteSetup(() => {
    // Unique per run: Windows can refuse to delete read-only Git objects left
    // by a previous run, so never reuse an old fixture directory.
    repositoryRoot = join(
      tmpdir(),
      `refhaven-extension-tests-${process.pid.toString()}-${Date.now().toString()}`,
    );
    rmSync(repositoryRoot, { force: true, recursive: true });
    mkdirSync(repositoryRoot, { recursive: true });
    git("init", "--initial-branch=main");
    git("config", "user.name", "RefHaven Tests");
    git("config", "user.email", "refhaven@example.invalid");
    git("remote", "add", "origin", "git@gitlab.example.invalid:group/project.git");
    writeFileSync(join(repositoryRoot, "modified.txt"), "before\n", "utf8");
    writeFileSync(join(repositoryRoot, "deleted.txt"), "deleted\n", "utf8");
    writeFileSync(join(repositoryRoot, "rename-old.txt"), "renamed\n", "utf8");
    git("add", ".");
    git("commit", "-m", "base");
    git("switch", "-c", "feature/native-diff");
    writeFileSync(join(repositoryRoot, "modified.txt"), "after\n", "utf8");
    writeFileSync(join(repositoryRoot, "added.txt"), "added\n", "utf8");
    git("rm", "deleted.txt");
    git("mv", "rename-old.txt", "rename-new.txt");
    git("add", ".");
    git("commit", "-m", "feature changes");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    try {
      rmSync(repositoryRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    } catch {
      // Best-effort cleanup; leftovers live in %TEMP% under a unique name.
    }
  });

  test("calculates merge-base changes and opens a native immutable diff", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();

    const comparison = createComparison(repositoryRoot);
    const result = await calculateComparison(comparison);
    assert.equal(result.fromSha, git("rev-parse", "refs/heads/main"));
    assert.equal(result.toSha, git("rev-parse", "refs/heads/feature/native-diff"));
    assert.deepEqual(
      result.files.map(({ newPath, oldPath, status }) => ({ newPath, oldPath, status })),
      [
        { newPath: "added.txt", oldPath: undefined, status: "added" },
        { newPath: "deleted.txt", oldPath: undefined, status: "deleted" },
        { newPath: "modified.txt", oldPath: undefined, status: "modified" },
        { newPath: "rename-new.txt", oldPath: "rename-old.txt", status: "renamed" },
      ],
    );

    const treeProvider = new ComparisonTreeProvider();
    treeProvider.setComparisons([comparison]);
    treeProvider.setComparisonLoader(() => Promise.resolve(result));
    const [comparisonNode] = await treeProvider.getChildren();
    assert.ok(comparisonNode);
    assert.equal(
      treeProvider.getTreeItem(comparisonNode).collapsibleState,
      vscode.TreeItemCollapsibleState.Collapsed,
    );

    const sections = await treeProvider.getChildren(comparisonNode);
    const filesSection = sections.find(
      (node) => node.kind === "section" && node.section === "files",
    );
    assert.ok(filesSection, "Expected the comparison to expose a changed-files section");
    const fileNodes = await treeProvider.getChildren(filesSection);
    const modifiedNode = fileNodes.find(
      (node) => treeProvider.getTreeItem(node).label === "modified.txt",
    );
    assert.ok(modifiedNode);
    const modifiedItem = treeProvider.getTreeItem(modifiedNode);
    const command = modifiedItem.command;
    assert.ok(command);
    assert.equal(command.command, "refhaven.openFileDiff");
    const commandArguments = (command.arguments ?? []) as readonly unknown[];
    await vscode.commands.executeCommand(command.command, ...commandArguments);

    assert.ok(
      vscode.window.visibleTextEditors.some(({ document }) => document.uri.scheme === "refhaven"),
      "Expected vscode.diff to open RefHaven revision documents",
    );
    const revisionDocuments = vscode.workspace.textDocuments.filter(
      ({ uri }) => uri.scheme === "refhaven",
    );
    assert.deepEqual(revisionDocuments.map((document) => document.getText()).sort(), [
      "after\n",
      "before\n",
    ]);
  });

  test("loads file and line history without leaving the repository", async () => {
    const fileHistory = await listFileHistory(repositoryRoot, "rename-new.txt");
    assert.equal(fileHistory.length, 2);
    const [latestEntry, originalEntry] = fileHistory;
    assert.ok(latestEntry);
    assert.ok(originalEntry);
    assert.equal(latestEntry.change.status, "renamed");
    assert.equal(latestEntry.change.oldPath, "rename-old.txt");
    assert.equal(originalEntry.change.newPath, "rename-old.txt");

    const lineHistory = await listLineHistory(repositoryRoot, "modified.txt", 1, 1);
    assert.deepEqual(
      lineHistory.map(({ subject }) => subject),
      ["feature changes", "base"],
    );
  });

  test("compares a reference with the live working tree", async () => {
    writeFileSync(join(repositoryRoot, "modified.txt"), "working tree\n", "utf8");
    try {
      const comparison: SavedComparisonV1 = {
        ...createComparison(repositoryRoot),
        baseRef: { displayName: "main", fullName: "refs/heads/main", kind: "localBranch" },
        id: "working-tree-test",
        mode: "workingTree",
        targetRef: {
          displayName: "Working Tree",
          fullName: "WORKTREE",
          kind: "workingTree",
        },
      };
      const result = await calculateComparison(comparison);
      assert.equal(result.toSha, null);
      assert.ok(result.files.some(({ newPath }) => newPath === "modified.txt"));
    } finally {
      writeFileSync(join(repositoryRoot, "modified.txt"), "after\n", "utf8");
    }
  });

  test("limits a working-tree comparison to the selected file", async () => {
    writeFileSync(join(repositoryRoot, "modified.txt"), "working tree\n", "utf8");
    writeFileSync(join(repositoryRoot, "added.txt"), "also changed\n", "utf8");
    try {
      const changes = await listWorkingTreeFileChanges(
        repositoryRoot,
        git("rev-parse", "HEAD"),
        "modified.txt",
      );
      assert.deepEqual(
        changes.map(({ newPath, status }) => ({ newPath, status })),
        [{ newPath: "modified.txt", status: "modified" }],
      );
    } finally {
      writeFileSync(join(repositoryRoot, "modified.txt"), "after\n", "utf8");
      writeFileSync(join(repositoryRoot, "added.txt"), "added\n", "utf8");
    }
  });

  test("rejects command file contexts from repositories outside the workspace", async () => {
    const target = await resolveFileContextTarget(
      vscode.Uri.file(join(repositoryRoot, "modified.txt")),
    );
    assert.equal(target, null);
  });

  test("loads a bounded local commit diff preview", async () => {
    const preview = await readCommitDiffPreview(
      repositoryRoot,
      git("rev-parse", "HEAD^"),
      git("rev-parse", "HEAD"),
      "modified.txt",
    );

    assert.ok(preview);
    assert.match(preview, /-before/u);
    assert.match(preview, /\+after/u);
  });

  test("searches local commits and loads full commit details", async () => {
    const byMessage = await searchCommits(repositoryRoot, "message", "feature changes");
    assert.equal(byMessage[0]?.subject, "feature changes");
    const byAuthor = await searchCommits(repositoryRoot, "author", "RefHaven Tests");
    assert.ok(byAuthor.length >= 2);
    const byContent = await searchCommits(repositoryRoot, "content", "added");
    assert.equal(byContent[0]?.subject, "feature changes");
    const bySha = await searchCommits(repositoryRoot, "sha", git("rev-parse", "HEAD").slice(0, 10));
    assert.equal(bySha.length, 1);

    const details = await readCommitDetails(repositoryRoot, git("rev-parse", "HEAD"));
    assert.equal(details.commit.subject, "feature changes");
    assert.equal(details.authorEmail, "refhaven@example.invalid");
    assert.equal(details.parentShas.length, 1);
  });

  test("lists worktrees through local porcelain metadata", async () => {
    const worktrees = await listWorktrees(repositoryRoot);
    assert.equal(worktrees.length, 1);
    const [worktree] = worktrees;
    assert.ok(worktree);
    assert.equal(worktree.branchFullName, "refs/heads/feature/native-diff");
    assert.equal(worktree.detached, false);
    assert.deepEqual(await readWorktreeState(repositoryRoot), {
      changedPaths: 0,
      conflicted: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
  });

  test("loads enriched branch metadata and bounded local history", async () => {
    const branches = await listBranchDetails(repositoryRoot);
    const feature = branches.find(
      ({ branch }) => branch.fullName === "refs/heads/feature/native-diff",
    );
    assert.ok(feature);
    assert.equal(feature.latestCommit.subject, "feature changes");
    assert.equal(feature.sha, git("rev-parse", "HEAD"));

    const commits = await listRecentCommits(repositoryRoot, feature.branch.fullName, 1);
    assert.deepEqual(
      commits.map(({ subject }) => subject),
      ["feature changes"],
    );
  });

  test("reads configured remote URLs without contacting them", async () => {
    assert.deepEqual(await listGitRemoteUrls(repositoryRoot), [
      {
        name: "origin",
        url: "git@gitlab.example.invalid:group/project.git",
      },
    ]);
  });

  test("verifies only blob paths available at an immutable local revision", async () => {
    const head = git("rev-parse", "HEAD");
    assert.equal(await fileExistsAtRevision(repositoryRoot, head, "modified.txt"), true);
    assert.equal(await fileExistsAtRevision(repositoryRoot, head, "missing.txt"), false);
  });

  test("loads whole-file blame and changed line ranges locally", async () => {
    const committed = await blameFile(repositoryRoot, "modified.txt");
    assert.equal(committed.length, 1);
    assert.equal(committed[0]?.blame.isCommitted, true);

    const unsaved = await blameFile(repositoryRoot, "modified.txt", "unsaved buffer\n");
    assert.equal(unsaved.length, 1);
    assert.equal(unsaved[0]?.blame.isCommitted, false);

    writeFileSync(join(repositoryRoot, "modified.txt"), "after\nnew line\n", "utf8");
    try {
      const ranges = await listChangedLineRanges(
        repositoryRoot,
        git("rev-parse", "HEAD"),
        "modified.txt",
      );
      assert.deepEqual(ranges, [{ lineCount: 1, startLine: 2 }]);
    } finally {
      writeFileSync(join(repositoryRoot, "modified.txt"), "after\n", "utf8");
    }
  });

  function git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  }
});

function createComparison(repositoryRoot: string): SavedComparisonV1 {
  return {
    baseRef: {
      displayName: "main",
      fullName: "refs/heads/main",
      kind: "localBranch",
    },
    createdAt: 1,
    id: "native-diff-test",
    mode: "branchChanges",
    order: 0,
    pinned: false,
    repository: {
      label: "fixture",
      relativeRepositoryPath: ".",
      rootPath: repositoryRoot,
      workspaceFolderUri: vscode.Uri.file(repositoryRoot).toString(),
    },
    schemaVersion: 1,
    targetRef: {
      displayName: "feature/native-diff",
      fullName: "refs/heads/feature/native-diff",
      kind: "localBranch",
    },
    updatedAt: 1,
  };
}
