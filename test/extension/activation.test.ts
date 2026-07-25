import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import { resolveFileContextTarget } from "../../src/ui/commands/fileContext";

const EXTENSION_ID = "patriziofilloramo.refhaven";

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
      vscode.Uri.joinPath(workspaceFolder.uri, ".gitkeep"),
    );
    assert.ok(workspaceTarget);
    assert.equal(workspaceTarget.filePath, "test/fixtures/workspace/.gitkeep");
    const sourceControlTarget = await resolveFileContextTarget({
      resourceUri: vscode.Uri.joinPath(workspaceFolder.uri, ".gitkeep"),
    });
    assert.equal(sourceControlTarget?.filePath, "test/fixtures/workspace/.gitkeep");

    const outsideTarget = await resolveFileContextTarget(
      vscode.Uri.file(join(tmpdir(), "refhaven-outside-workspace.txt")),
    );
    assert.equal(outsideTarget, null);
  });

  test("provides rich local blame hover across the full file line", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, ".gitkeep");
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
