import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import { listStashes, readFileAtRevision } from "../../src/infrastructure/git/GitCli";
import { resolveFileContextTarget } from "../../src/ui/commands/fileContext";

const EXTENSION_ID = "patriziofilloramo.refhaven";
const FIXTURE_FILE = "fixture.txt";
const NESTED_FIXTURE_FILE = "nested/deleted.txt";

interface GitChange {
  readonly uri: vscode.Uri;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly indexChanges: readonly GitChange[];
    readonly workingTreeChanges: readonly GitChange[];
  };
  dropStash(index?: number): Promise<void>;
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): { readonly repositories: readonly GitRepository[] };
}

suite("RefHaven extension", () => {
  test("activates and registers its public commands", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);

    assert.ok(extension, `Expected extension ${EXTENSION_ID} to be installed`);
    await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("refhaven.newComparison"));
    assert.ok(commands.includes("refhaven.openAllComparisonChanges"));
    assert.ok(commands.includes("refhaven.compareCurrentBranch"));
    assert.ok(commands.includes("refhaven.compareSelectedBranches"));
    assert.ok(commands.includes("refhaven.openFileDiff"));
    assert.ok(commands.includes("refhaven.showRefHavenMenu"));
    assert.ok(commands.includes("refhaven.showFileHistory"));
    assert.ok(commands.includes("refhaven.compareFileWithRevision"));
    assert.ok(commands.includes("refhaven.stashFile"));
    assert.ok(commands.includes("refhaven.compareStashFileWithHead"));
    assert.ok(commands.includes("refhaven.openBrowserProject"));
    assert.ok(commands.includes("refhaven.openBrowserFile"));
    assert.ok(commands.includes("refhaven.openBrowserComparison"));
    assert.ok(commands.includes("refhaven.openBrowserLocalReference"));
    assert.ok(commands.includes("refhaven.configureBrowserOrigin"));
    assert.ok(commands.includes("refhaven.copyBrowserFileUrl"));
    assert.ok(commands.includes("refhaven.inspectCurrentLine"));
    assert.ok(commands.includes("refhaven.revealFileInComparison"));
    assert.ok(commands.includes("refhaven.quickOpenComparisonFile"));
    assert.ok(commands.includes("refhaven.markFileReviewed"));
    assert.ok(commands.includes("refhaven.nextUnreviewedFile"));
    assert.ok(commands.includes("refhaven.changeStashFilter"));
    assert.ok(commands.includes("refhaven.changeFileHistoryFilter"));
    assert.ok(commands.includes("refhaven.compareCommitWithParent"));
    assert.ok(commands.includes("refhaven.renameComparison"));
    assert.ok(commands.includes("refhaven.copyComparisonPatch"));
    assert.ok(commands.includes("refhaven.saveComparisonPatch"));
    assert.ok(commands.includes("refhaven.copyFilePatch"));
    assert.ok(commands.includes("refhaven.refreshAll"));
    assert.ok(commands.includes("refhaven.comparisons.focus"));
    assert.ok(commands.includes("refhaven.inspector.focus"));
    assert.ok(commands.includes("refhaven.repository.focus"));
    await vscode.commands.executeCommand("refhaven.comparisons.focus");
  });

  test("accepts workspace files and rejects file contexts outside known repositories", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const workspaceTarget = await resolveFileContextTarget(
      vscode.Uri.joinPath(workspaceFolder.uri, FIXTURE_FILE),
    );
    assert.ok(workspaceTarget);
    assert.equal(workspaceTarget.filePath, FIXTURE_FILE);
    const sourceControlTarget = await resolveFileContextTarget({
      resourceUri: vscode.Uri.joinPath(workspaceFolder.uri, FIXTURE_FILE),
    });
    assert.equal(sourceControlTarget?.filePath, FIXTURE_FILE);

    const outsideTarget = await resolveFileContextTarget(
      vscode.Uri.file(join(tmpdir(), "refhaven-outside-workspace.txt")),
    );
    assert.equal(outsideTarget, null);
  });

  test("accepts a real change object from the Git extension API", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, FIXTURE_FILE);
    const original = await vscode.workspace.fs.readFile(uri);

    try {
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.concat([Buffer.from(original), Buffer.from("SCM command context\n")]),
      );
      const change = await waitForGitChange(uri);
      const target = await resolveFileContextTarget(change);

      assert.ok(target);
      assert.equal(target.filePath, FIXTURE_FILE);
      assert.equal(target.uri.fsPath, uri.fsPath);
    } finally {
      await vscode.workspace.fs.writeFile(uri, original);
      await vscode.commands.executeCommand("git.refresh");
    }
  });

  test("resolves a deleted SCM resource whose parent directory no longer exists", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, NESTED_FIXTURE_FILE);
    const parentUri = vscode.Uri.joinPath(workspaceFolder.uri, "nested");
    const original = await vscode.workspace.fs.readFile(uri);

    try {
      await vscode.workspace.fs.delete(parentUri, { recursive: true });
      const change = await waitForGitChange(uri);
      const target = await resolveFileContextTarget(change);

      assert.ok(target);
      assert.equal(target.filePath, NESTED_FIXTURE_FILE);
      assert.equal(target.uri.fsPath, uri.fsPath);
    } finally {
      await vscode.workspace.fs.createDirectory(parentUri);
      await vscode.workspace.fs.writeFile(uri, original);
      await vscode.commands.executeCommand("git.refresh");
    }
  });

  test("leaves unsaved editor changes untouched when the stash prompt is cancelled", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, FIXTURE_FILE);
    const diskContentsBefore = await vscode.workspace.fs.readFile(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);

    try {
      const edited = await editor.edit((editBuilder) => {
        editBuilder.insert(document.positionAt(document.getText().length), "unsaved stash guard\n");
      });
      assert.equal(edited, true);
      assert.equal(document.isDirty, true);

      const operation = vscode.commands.executeCommand("refhaven.stashFile", uri);
      await driveQuickInputUntilSettled(
        operation,
        "workbench.action.closeQuickOpen",
        5_000,
        "The cancelled stash command did not complete.",
      );

      assert.equal(document.isDirty, true);
      assert.deepEqual(await vscode.workspace.fs.readFile(uri), diskContentsBefore);
    } finally {
      if (document.isDirty) {
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
    }
  });

  test("saves and stashes unsaved editor changes after confirmation", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, FIXTURE_FILE);
    const original = await vscode.workspace.fs.readFile(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    const expectedMessage = `RefHaven: ${FIXTURE_FILE}`;
    let clearNotifications: NodeJS.Timeout | undefined;

    try {
      const edited = await editor.edit((editBuilder) => {
        editBuilder.insert(document.positionAt(document.getText().length), "confirmed stash\n");
      });
      assert.equal(edited, true);
      assert.equal(document.isDirty, true);

      const operation = vscode.commands.executeCommand("refhaven.stashFile", uri);
      clearNotifications = setInterval(() => {
        void vscode.commands.executeCommand("notifications.clearAll");
      }, 250);
      await driveQuickInputUntilSettled(
        operation,
        "workbench.action.acceptSelectedQuickOpenItem",
        15_000,
        "The public stash command did not complete.",
      );

      assert.equal(document.isDirty, false);
      const stash = (await listStashes(workspaceFolder.uri.fsPath))[0];
      assert.equal(stash?.message, expectedMessage);
      assert.ok(stash);
      const stashedText = Buffer.from(
        await readFileAtRevision(workspaceFolder.uri.fsPath, stash.sha, FIXTURE_FILE),
      )
        .toString("utf8")
        .replaceAll("\r\n", "\n");
      const cleanedText = Buffer.from(await vscode.workspace.fs.readFile(uri))
        .toString("utf8")
        .replaceAll("\r\n", "\n");
      const originalText = Buffer.from(original).toString("utf8").replaceAll("\r\n", "\n");
      assert.equal(stashedText, `${originalText}confirmed stash\n`);
      assert.equal(cleanedText, originalText);
    } finally {
      if (clearNotifications) clearInterval(clearNotifications);
      await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
      await vscode.commands.executeCommand("notifications.clearAll");
      if (document.isDirty) await vscode.commands.executeCommand("workbench.action.files.revert");
      const stash = (await listStashes(workspaceFolder.uri.fsPath))[0];
      if (stash?.message === expectedMessage) {
        await getGitRepository().then((repository) => repository.dropStash(0));
      }
      await vscode.workspace.fs.writeFile(uri, original);
      await vscode.commands.executeCommand("git.refresh");
    }
  });

  test("provides rich local blame hover across the full file line", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, FIXTURE_FILE);
    const document = await vscode.workspace.openTextDocument(uri);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      new vscode.Position(0, 0),
    );
    const markdown = hovers
      .flatMap(({ contents }) => contents)
      .map((content) =>
        typeof content === "string" ? content : (content as { readonly value: string }).value,
      )
      .join("\n");

    assert.match(markdown, /Commit Details/u);
    assert.match(markdown, /Diff Working Tree/u);
    assert.match(markdown, /File History/u);
  });
});

async function waitForGitChange(uri: vscode.Uri): Promise<GitChange> {
  const repository = await getGitRepository();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await vscode.commands.executeCommand("git.refresh");
    const change = [...repository.state.workingTreeChanges, ...repository.state.indexChanges].find(
      ({ uri: changeUri }) => changeUri.fsPath === uri.fsPath,
    );
    if (change) return change;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Git did not publish the fixture change to the SCM view.");
}

async function getGitRepository(): Promise<GitRepository> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  assert.ok(extension);
  const exports = await extension.activate();
  assert.equal(exports.enabled, true);
  const repository = exports
    .getAPI(1)
    .repositories.find(
      ({ rootUri }) => rootUri.fsPath === vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    );
  assert.ok(repository);
  return repository;
}

async function withTimeout<T>(
  operation: Thenable<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function driveQuickInputUntilSettled<T>(
  operation: Thenable<T>,
  command: string,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const completion = withTimeout(operation, timeoutMs, timeoutMessage).then((value) => ({
    completed: true as const,
    value,
  }));
  const drive = async (): Promise<T> => {
    const result = await Promise.race([
      completion,
      (async (): Promise<{ readonly completed: false }> => {
        await vscode.commands.executeCommand(command);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { completed: false as const };
      })(),
    ]);
    return result.completed ? result.value : drive();
  };
  return drive();
}
