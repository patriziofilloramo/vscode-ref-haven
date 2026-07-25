import { runTests } from "@vscode/test-electron";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// An integrated Extension Host terminal can export these variables. Passing
// them to Code.exe would start it as a Node process instead of VS Code.
Reflect.deleteProperty(process.env, "ELECTRON_RUN_AS_NODE");
Reflect.deleteProperty(process.env, "VSCODE_ESM_ENTRYPOINT");

await runTests({
  extensionDevelopmentPath: projectRoot,
  extensionTestsPath: resolve(projectRoot, ".test-out", "test", "extension", "index.js"),
  launchArgs: [
    resolve(projectRoot, "test", "fixtures", "workspace"),
    "--disable-extensions",
    `--user-data-dir=${resolve(projectRoot, ".vscode-test", "user-data")}`,
  ],
  version: "stable",
});
