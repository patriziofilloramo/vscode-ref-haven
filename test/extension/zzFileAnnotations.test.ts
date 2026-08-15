import assert from "node:assert/strict";

import * as vscode from "vscode";

const CONFIGURATION_SECTION = "refhaven";
const MODE_SETTING = "fileAnnotations.mode";
const TOGGLE_MODE_SETTING = "fileAnnotations.heatmap.toggleMode";

suite("File annotations", () => {
  teardown(async () => {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    await configuration.update(MODE_SETTING, undefined, vscode.ConfigurationTarget.Global);
    await configuration.update(TOGGLE_MODE_SETTING, undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("scopes heatmap toggles per file and lets Escape-style dismissal stay temporary", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    await configuration.update(MODE_SETTING, "off", vscode.ConfigurationTarget.Global);
    await configuration.update(TOGGLE_MODE_SETTING, "file", vscode.ConfigurationTarget.Global);

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, "fixture.txt");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    await vscode.commands.executeCommand("refhaven.toggleFileHeatmap", uri);
    assert.equal(readSetting(MODE_SETTING), "off", "file scope must not persist a mode");

    await vscode.commands.executeCommand("refhaven.dismissFileAnnotations");
    assert.equal(readSetting(MODE_SETTING), "off", "dismissal must remain file-local");

    await vscode.commands.executeCommand("refhaven.toggleFileHeatmap", uri);
    assert.equal(readSetting(MODE_SETTING), "off", "re-enabling the file stays temporary");

    await configuration.update(TOGGLE_MODE_SETTING, "window", vscode.ConfigurationTarget.Global);
    await waitForSetting(TOGGLE_MODE_SETTING, "window");
    await vscode.commands.executeCommand("refhaven.toggleFileHeatmap", uri);
    await waitForSetting(MODE_SETTING, "heatmap");

    await vscode.commands.executeCommand("refhaven.dismissFileAnnotations");
    assert.equal(
      readSetting(MODE_SETTING),
      "heatmap",
      "dismissal must not rewrite the persisted window preference",
    );
  });
});

async function waitForSetting(setting: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = readSetting(setting);
    if (value === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(readSetting(setting), expected);
}

function readSetting(setting: string): unknown {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get(setting);
}
