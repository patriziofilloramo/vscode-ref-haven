import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));

if (
  typeof manifest.name !== "string" ||
  typeof manifest.publisher !== "string" ||
  typeof manifest.version !== "string" ||
  manifest.name.length === 0 ||
  manifest.publisher.length === 0 ||
  manifest.version.length === 0
) {
  throw new Error("package.json does not contain a valid extension identity and version.");
}

const vsixPath = resolve(projectRoot, `branch-compare-${manifest.version}.vsix`);
await access(vsixPath);

function runCodeCli(arguments_, stdio) {
  if (process.platform === "win32") {
    return spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "code.cmd", ...arguments_],
      { encoding: "utf8", stdio, windowsHide: true },
    );
  }

  return spawnSync("code", arguments_, { encoding: "utf8", stdio });
}

const installation = runCodeCli(["--install-extension", vsixPath, "--force"], "inherit");

if (installation.error !== undefined) {
  throw installation.error;
}

if (installation.status !== 0) {
  throw new Error(
    `VS Code extension installation exited with code ${installation.status ?? "unknown"}.`,
  );
}

const verification = runCodeCli(["--list-extensions", "--show-versions"], "pipe");

if (verification.error !== undefined) {
  throw verification.error;
}

if (verification.status !== 0) {
  throw new Error(
    `Unable to verify the VS Code extension installation (exit code ${verification.status ?? "unknown"}).`,
  );
}

const extensionId = `${manifest.publisher}.${manifest.name}@${manifest.version}`.toLowerCase();
const installedExtensions = String(verification.stdout)
  .split(/\r?\n/u)
  .map((line) => line.trim().toLowerCase());

if (!installedExtensions.includes(extensionId)) {
  throw new Error(`VS Code reported success, but ${extensionId} is not installed.`);
}

process.stdout.write(`Verified local installation: ${extensionId}\n`);
