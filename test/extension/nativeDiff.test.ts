import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import { calculateComparison } from "../../src/application/ComparisonEngine";
import type { SavedComparisonV1 } from "../../src/domain/comparison";
import { resolveGitLabProjects } from "../../src/domain/gitLab";
import {
  blameFile,
  blameLine,
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
  readComparisonPatch,
  readWorktreeState,
  searchCommits,
} from "../../src/infrastructure/git/GitCli";
import { previewMerge } from "../../src/infrastructure/git/mergePreview";
import { resolveFileContextTarget } from "../../src/ui/commands/fileContext";
import { ComparisonTreeProvider } from "../../src/ui/tree/ComparisonTreeProvider";

const EXTENSION_ID = "patriziofilloramo.refhaven";

suite("native branch diff", () => {
  let repositoryRoot: string;
  let mergeTreeSupport: boolean | undefined;

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
    assert.equal(
      result.mergePreview?.kind,
      mergeTreeWriteTreeSupported() ? "clean" : "unavailable",
    );
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
    const [leftDocument, rightDocument] = revisionDocuments;
    assert.ok(leftDocument);
    assert.ok(rightDocument);
    await vscode.commands.executeCommand("vscode.changes", "RefHaven test changes", [
      [vscode.Uri.file(join(repositoryRoot, "modified.txt")), leftDocument.uri, rightDocument.uri],
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

  test("blames a line at a pinned local revision for time-travel hover", async () => {
    const baseSha = git("rev-parse", "refs/heads/main");
    const featureSha = git("rev-parse", "refs/heads/feature/native-diff");

    const atBase = await blameLine(
      repositoryRoot,
      "modified.txt",
      1,
      undefined,
      undefined,
      baseSha,
    );
    assert.ok(atBase);
    assert.equal(atBase.sha, baseSha);
    const atFeature = await blameLine(
      repositoryRoot,
      "modified.txt",
      1,
      undefined,
      undefined,
      featureSha,
    );
    assert.ok(atFeature);
    assert.equal(atFeature.sha, featureSha);
    assert.equal(atFeature.previousSha, baseSha);

    await assert.rejects(
      blameLine(repositoryRoot, "modified.txt", 1, "buffer\n", undefined, baseSha),
      /either buffer contents or a revision/u,
    );
    await assert.rejects(
      blameLine(repositoryRoot, "modified.txt", 1, undefined, undefined, "main"),
      /blame revision is invalid/u,
    );
  });

  test("produces shareable patches for comparisons and single files", async () => {
    const baseSha = git("rev-parse", "refs/heads/main");
    const featureSha = git("rev-parse", "refs/heads/feature/native-diff");

    const full = (await readComparisonPatch(repositoryRoot, baseSha, featureSha)).toString("utf8");
    assert.match(full, /^diff --git/mu);
    assert.match(full, /-before/u);
    assert.match(full, /\+after/u);
    assert.match(full, /rename-new\.txt/u);

    const single = (
      await readComparisonPatch(repositoryRoot, baseSha, featureSha, ["modified.txt"])
    ).toString("utf8");
    assert.match(single, /modified\.txt/u);
    assert.doesNotMatch(single, /added\.txt/u);

    const root = (await readComparisonPatch(repositoryRoot, null, baseSha)).toString("utf8");
    assert.match(root, /modified\.txt/u);
    assert.match(root, /\+before/u);

    writeFileSync(join(repositoryRoot, "modified.txt"), "working\n", "utf8");
    try {
      const workingTree = (
        await readComparisonPatch(repositoryRoot, featureSha, null, ["modified.txt"])
      ).toString("utf8");
      assert.match(workingTree, /\+working/u);
    } finally {
      writeFileSync(join(repositoryRoot, "modified.txt"), "after\n", "utf8");
    }

    await assert.rejects(
      readComparisonPatch(repositoryRoot, null, null),
      /at least one resolved revision/u,
    );
    await assert.rejects(
      readComparisonPatch(repositoryRoot, "main", featureSha),
      /patch revision is invalid/u,
    );
  });

  test("preserves exact bytes and a raised ceiling for exported patches", async () => {
    const headSha = git("rev-parse", "HEAD");

    // A byte that is invalid UTF-8 on its own must survive verbatim so the
    // saved patch applies cleanly, rather than becoming the replacement char.
    writeFileSync(
      join(repositoryRoot, "modified.txt"),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    );
    try {
      const patch = await readComparisonPatch(repositoryRoot, headSha, null, ["modified.txt"]);
      assert.ok(patch.includes(0xe9), "raw non-UTF-8 byte is preserved");
      assert.ok(
        !patch.includes(Buffer.from([0xef, 0xbf, 0xbd])),
        "no UTF-8 replacement character is introduced",
      );
    } finally {
      writeFileSync(join(repositoryRoot, "modified.txt"), "after\n", "utf8");
    }

    // A 6 MiB patch exceeds the 5 MiB text ceiling but stays within the
    // dedicated patch ceiling, so export no longer fails on large diffs.
    writeFileSync(join(repositoryRoot, "modified.txt"), `${"x".repeat(6 * 1024 * 1024)}\n`, "utf8");
    try {
      const large = await readComparisonPatch(repositoryRoot, headSha, null, ["modified.txt"]);
      assert.ok(large.length > 6 * 1024 * 1024);
    } finally {
      writeFileSync(join(repositoryRoot, "modified.txt"), "after\n", "utf8");
    }
  });

  test("forecasts merge conflicts without touching the worktree or index", async function () {
    if (!mergeTreeWriteTreeSupported()) {
      // Forecasts need `merge-tree --write-tree` (Git 2.38+); production
      // degrades to no forecast, which the calculation test covers.
      this.skip();
    }
    const featureSha = git("rev-parse", "refs/heads/feature/native-diff");
    const mainSha = git("rev-parse", "refs/heads/main");

    // main is an ancestor of the feature branch, so the merge is clean.
    const clean = await previewMerge(repositoryRoot, mainSha, featureSha);
    assert.deepEqual(clean, { kind: "clean" });

    // A branch that edits the same line as the feature branch must conflict.
    git("switch", "-c", "conflict/native-diff", "main");
    writeFileSync(join(repositoryRoot, "modified.txt"), "conflicting\n", "utf8");
    git("add", ".");
    git("commit", "-m", "conflicting change");
    git("switch", "feature/native-diff");
    try {
      const conflictSha = git("rev-parse", "refs/heads/conflict/native-diff");
      const conflicted = await previewMerge(repositoryRoot, conflictSha, featureSha);
      assert.equal(conflicted.kind, "conflicts");
      assert.ok(
        conflicted.conflictedPaths.includes("modified.txt"),
        "expected modified.txt to be forecast as conflicting",
      );
      assert.equal(
        git("status", "--porcelain"),
        "",
        "the merge preview must not touch the worktree or index",
      );
    } finally {
      git("branch", "-D", "conflict/native-diff");
    }

    await assert.rejects(
      previewMerge(repositoryRoot, "main", featureSha),
      /merge preview base revision is invalid/u,
    );
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
    const remotes = await listGitRemoteUrls(repositoryRoot);
    assert.deepEqual(remotes, [
      {
        name: "origin",
        url: "git@gitlab.example.invalid:group/project.git",
      },
    ]);
    assert.deepEqual(resolveGitLabProjects(remotes, []), [
      {
        browserOrigin: {
          hostKind: "gitlab",
          hostname: "gitlab.example.invalid",
          origin: "https://gitlab.example.invalid",
        },
        projectPath: "group/project",
        remoteName: "origin",
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

  function mergeTreeWriteTreeSupported(): boolean {
    if (mergeTreeSupport === undefined) {
      try {
        const head = git("rev-parse", "HEAD");
        git("merge-tree", "--write-tree", head, head);
        mergeTreeSupport = true;
      } catch {
        mergeTreeSupport = false;
      }
    }
    return mergeTreeSupport;
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
