import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const testOutput = resolve(projectRoot, ".test-out");
const pathFromRoot = relative(projectRoot, testOutput);

if (pathFromRoot !== ".test-out") {
  throw new Error(`Refusing to clean unexpected test output path: ${testOutput}`);
}

await rm(testOutput, { force: true, recursive: true });
