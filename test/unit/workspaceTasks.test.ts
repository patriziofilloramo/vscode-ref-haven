import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface WorkspaceTask {
  readonly args?: readonly string[];
  readonly command?: string;
  readonly dependsOn?: string;
  readonly dependsOrder?: string;
  readonly label: string;
  readonly script?: string;
  readonly type: string;
}

interface WorkspaceTasks {
  readonly tasks: readonly WorkspaceTask[];
}

function loadTasks(): WorkspaceTasks {
  const tasksPath = resolve(__dirname, "../../../.vscode/tasks.json");
  return JSON.parse(readFileSync(tasksPath, "utf8")) as WorkspaceTasks;
}

suite("workspace tasks", () => {
  test("packages before installing the versioned VSIX into the current VS Code", () => {
    const tasks = loadTasks().tasks;
    const packageTask = tasks.find(({ label }) => label === "npm: package");
    const installTask = tasks.find(({ label }) => label === "Branch Compare: Install Local VSIX");

    assert.deepEqual(packageTask, {
      label: "npm: package",
      problemMatcher: [],
      script: "package",
      type: "npm",
    });
    assert.deepEqual(installTask, {
      args: ["${workspaceFolder}/scripts/install-local.mjs"],
      command: "node",
      dependsOn: "npm: package",
      dependsOrder: "sequence",
      label: "Branch Compare: Install Local VSIX",
      problemMatcher: [],
      type: "process",
    });
  });
});
