import assert from "node:assert/strict";
import { dirname, join } from "node:path";

import * as vscode from "vscode";

import { pathIdentityKey } from "../../src/domain/pathValidation";
import { discoverRepositories } from "../../src/infrastructure/git/GitCli";
import { resolveFileContextTarget } from "../../src/ui/commands/fileContext";

const EXTENSION_ID = "patriziofilloramo.refhaven";

suite("ancestor repository workspace", () => {
  test("provides file intelligence when the opened folder is below the Git root", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await waitForExtensionActivation(extension);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const repositoryRoot = dirname(workspaceFolder.uri.fsPath);
    const uri = vscode.Uri.file(join(workspaceFolder.uri.fsPath, "fixture.txt"));

    const target = await resolveFileContextTarget(uri);
    assert.ok(target);
    assert.equal(pathIdentityKey(target.repositoryRoot), pathIdentityKey(repositoryRoot));
    assert.equal(target.filePath, "opened-folder/fixture.txt");

    const repositories = await discoverRepositories();
    assert.equal(repositories.length, 1);
    assert.equal(pathIdentityKey(repositories[0]?.rootPath ?? ""), pathIdentityKey(repositoryRoot));

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

async function waitForExtensionActivation(extension: vscode.Extension<unknown>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!extension.isActive && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.equal(extension.isActive, true, "RefHaven did not activate after startup finished");
}
