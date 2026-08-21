import assert from "node:assert/strict";

import * as vscode from "vscode";

const CONFIGURATION_SECTION = "refhaven";
const MODE_SETTING = "fileAnnotations.mode";
const TOGGLE_MODE_SETTING = "fileAnnotations.heatmap.toggleMode";
const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 2_000;

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
    await waitForActiveEditor(uri);

    await vscode.commands.executeCommand("refhaven.toggleFileHeatmap", uri);
    assert.equal(readSetting(MODE_SETTING), "off", "file scope must not persist a mode");

    await vscode.commands.executeCommand("refhaven.dismissFileAnnotations");
    assert.equal(readSetting(MODE_SETTING), "off", "dismissal must remain file-local");

    await vscode.commands.executeCommand("refhaven.toggleFileHeatmap", uri);
    assert.equal(readSetting(MODE_SETTING), "off", "re-enabling the file stays temporary");

    await configuration.update(TOGGLE_MODE_SETTING, "window", vscode.ConfigurationTarget.Global);
    await waitForSetting(TOGGLE_MODE_SETTING, "window");
    await waitForActiveEditor(uri);
    await vscode.commands.executeCommand("refhaven.toggleFileHeatmap", uri);
    await waitForSetting(MODE_SETTING, "heatmap");

    await vscode.commands.executeCommand("refhaven.dismissFileAnnotations");
    assert.equal(
      readSetting(MODE_SETTING),
      "heatmap",
      "dismissal must not rewrite the persisted window preference",
    );
  });

  test("renders committed and unsaved lines into a navigable heatmap legend", async function () {
    this.timeout(5_000);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder);
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    await configuration.update(MODE_SETTING, "off", vscode.ConfigurationTarget.Global);
    await configuration.update(TOGGLE_MODE_SETTING, "file", vscode.ConfigurationTarget.Global);

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, "fixture.txt");
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    await waitForActiveEditor(uri);
    const end = document.lineAt(document.lineCount - 1).range.end;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, end, "\nunsaved heatmap line");
    assert.equal(await vscode.workspace.applyEdit(edit), true);

    try {
      await vscode.commands.executeCommand("refhaven.toggleFileHeatmap", uri);
      editor.selection = new vscode.Selection(0, 0, 0, 0);

      const legend = vscode.commands.executeCommand("refhaven.showFileHeatmapLegend", uri);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
      await legend;

      assert.equal(
        vscode.window.activeTextEditor?.selection.active.line,
        1,
        "the Working tree legend entry must navigate to the unsaved line",
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.files.revert");
    }
  });
});

/**
 * Toggling the heatmap needs an active tracked editor: without one the command
 * warns and changes nothing, which every later assertion in this test would
 * report as an unrelated timeout. `showTextDocument` can resolve before the
 * editor becomes active, so wait for it and fail here with the real cause.
 */
async function waitForActiveEditor(uri: vscode.Uri): Promise<void> {
  const expected = uri.toString();
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === expected);
  assert.equal(
    vscode.window.activeTextEditor?.document.uri.toString(),
    expected,
    "the toggled file must be the active editor",
  );
}

async function waitForSetting(setting: string, expected: string): Promise<void> {
  await waitFor(() => readSetting(setting) === expected);
  assert.equal(readSetting(setting), expected);
}

async function waitFor(satisfied: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (satisfied()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function readSetting(setting: string): unknown {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get(setting);
}
