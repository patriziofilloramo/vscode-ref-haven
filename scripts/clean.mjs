import { readdir, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixedTargets = ["build", "dist", ".test-out", ".vscode-test"];

for (const target of fixedTargets) await removeProjectEntry(target);

// Packages produced before the output moved into build/ may still sit here.
for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".vsix")) {
    await removeProjectEntry(entry.name);
  }
}

async function removeProjectEntry(projectRelativePath) {
  const absolutePath = resolve(projectRoot, projectRelativePath);
  const pathFromRoot = relative(projectRoot, absolutePath);
  if (pathFromRoot.length === 0 || pathFromRoot.startsWith("..")) {
    throw new Error(`Refusing to clean a path outside the project: ${projectRelativePath}`);
  }
  await rm(absolutePath, { force: true, recursive: true });
}
