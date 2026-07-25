import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import { calculateComparison } from "../../src/application/ComparisonEngine";
import type { SavedComparisonV1 } from "../../src/domain/comparison";
import { ComparisonTreeProvider } from "../../src/ui/tree/ComparisonTreeProvider";

const EXTENSION_ID = "local-development.branch-compare";

suite("native branch diff", () => {
  let repositoryRoot: string;

  suiteSetup(() => {
    repositoryRoot = join(tmpdir(), "branch-compare-extension-tests");
    rmSync(repositoryRoot, { force: true, recursive: true });
    mkdirSync(repositoryRoot);
    git("init", "--initial-branch=main");
    git("config", "user.name", "Branch Compare Tests");
    git("config", "user.email", "branch-compare@example.invalid");
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

    const fileNodes = await treeProvider.getChildren(comparisonNode);
    const modifiedNode = fileNodes.find(
      (node) => treeProvider.getTreeItem(node).label === "modified.txt",
    );
    assert.ok(modifiedNode);
    const modifiedItem = treeProvider.getTreeItem(modifiedNode);
    const command = modifiedItem.command;
    assert.ok(command);
    assert.equal(command.command, "branchCompare.openFileDiff");
    const commandArguments = (command.arguments ?? []) as readonly unknown[];
    await vscode.commands.executeCommand(command.command, ...commandArguments);

    assert.ok(
      vscode.window.visibleTextEditors.some(
        ({ document }) => document.uri.scheme === "branch-compare",
      ),
      "Expected vscode.diff to open Branch Compare revision documents",
    );
    const revisionDocuments = vscode.workspace.textDocuments.filter(
      ({ uri }) => uri.scheme === "branch-compare",
    );
    assert.deepEqual(revisionDocuments.map((document) => document.getText()).sort(), [
      "after\n",
      "before\n",
    ]);
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
