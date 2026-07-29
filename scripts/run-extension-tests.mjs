import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runTests } from "@vscode/test-electron";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);

// An integrated Extension Host terminal can export these variables. Passing
// them to Code.exe would start it as a Node process instead of VS Code.
Reflect.deleteProperty(process.env, "ELECTRON_RUN_AS_NODE");
Reflect.deleteProperty(process.env, "VSCODE_ESM_ENTRYPOINT");

const fixtureRoot = await mkdtemp(join(tmpdir(), "refhaven-extension-workspace-"));
const userDataRoot = await mkdtemp(join(tmpdir(), "refhaven-extension-user-data-"));
try {
  await createFixtureRepository(fixtureRoot, userDataRoot);
  await runTests({
    extensionDevelopmentPath: projectRoot,
    extensionTestsPath: resolve(projectRoot, ".test-out", "test", "extension", "index.js"),
    launchArgs: [fixtureRoot, "--disable-extensions", `--user-data-dir=${userDataRoot}`],
    version: "stable",
  });
} finally {
  await rm(fixtureRoot, { force: true, recursive: true });
  await rm(userDataRoot, { force: true, recursive: true });
}

async function createFixtureRepository(repositoryRoot, isolationRoot) {
  const templateDirectory = join(isolationRoot, "empty-git-template");
  await mkdir(templateDirectory, { recursive: true });
  const environment = buildFixtureGitEnvironment(isolationRoot, templateDirectory);
  const runGit = (...args) =>
    execFileAsync(
      "git",
      [
        "-c",
        `core.attributesFile=${join(isolationRoot, "empty-global-attributes")}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${join(isolationRoot, "disabled-hooks")}`,
        ...args,
      ],
      { cwd: repositoryRoot, env: environment, windowsHide: true },
    );

  await runGit("init");
  await mkdir(join(repositoryRoot, "nested"));
  await writeFile(join(repositoryRoot, "fixture.txt"), "tracked fixture line\n", "utf8");
  await writeFile(join(repositoryRoot, "nested", "deleted.txt"), "tracked nested line\n", "utf8");
  await runGit("add", "--", "fixture.txt", "nested/deleted.txt");
  await runGit(
    "-c",
    "user.name=RefHaven Extension Tests",
    "-c",
    "user.email=refhaven-tests@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    "test: create extension fixture",
  );
}

function buildFixtureGitEnvironment(isolationRoot, templateDirectory) {
  const environment = {
    ...process.env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(isolationRoot, "empty-global-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_TEMPLATE_DIR: templateDirectory,
  };
  for (const key of Object.keys(environment)) {
    if (
      key === "GIT_CONFIG_COUNT" ||
      key === "GIT_DIR" ||
      key === "GIT_INDEX_FILE" ||
      key === "GIT_WORK_TREE" ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
    ) {
      Reflect.deleteProperty(environment, key);
    }
  }
  return environment;
}
