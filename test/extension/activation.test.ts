import assert from "node:assert/strict";

import * as vscode from "vscode";

const EXTENSION_ID = "local-development.branch-compare";

suite("Branch Compare extension", () => {
  test("activates and registers its public commands", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);

    assert.ok(extension, `Expected extension ${EXTENSION_ID} to be installed`);
    await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("branchCompare.newComparison"));
    assert.ok(commands.includes("branchCompare.compareCurrentBranch"));
    assert.ok(commands.includes("branchCompare.refreshAll"));
  });
});
