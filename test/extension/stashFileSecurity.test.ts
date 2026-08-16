import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createPathLimitedStash,
  listPendingStashFileRecoveries,
  type StashFileResult,
} from "../../src/infrastructure/git/stashFile";
import { assertOrdinaryDirectory } from "../../src/infrastructure/git/stashFileTransaction";

suite("single-file stash security regressions", () => {
  const roots: string[] = [];

  teardown(() => {
    for (const root of roots.splice(0)) {
      try {
        rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
      } catch {
        // Best-effort cleanup below unique temporary directories.
      }
    }
  });

  test("does not broaden a selected file's 0600 POSIX permissions", async function () {
    if (process.platform === "win32") this.skip();
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    const selectedPath = join(repository.root, "selected.txt");
    chmodSync(selectedPath, 0o600);
    writeFileSync(selectedPath, "private change\n", "utf8");

    const result = await stash(repository, "selected.txt", "private file");

    assert.equal(filePermissions(selectedPath), 0o600);
    assert.equal(readFileSync(selectedPath, "utf8"), "base\n");
    assert.ok(result.safetyCopyDirectory);
    assert.equal(filePermissions(result.safetyCopyDirectory), 0o700);
    const safetyCopy = join(result.safetyCopyDirectory, "evacuated-0");
    assert.equal(filePermissions(safetyCopy), 0o600);
    assert.equal(readFileSync(safetyCopy, "utf8"), "private change\n");
  });

  test("round-trips a mode-only chmod with core.fileMode enabled", async function () {
    if (process.platform === "win32") this.skip();
    const repository = createRepository(roots, { "selected.sh": "#!/bin/sh\nexit 0\n" });
    const selectedPath = join(repository.root, "selected.sh");
    repository.git("config", "core.fileMode", "true");
    chmodSync(selectedPath, 0o644);
    assert.equal(treeMode(repository, "HEAD", "selected.sh"), "100644");
    chmodSync(selectedPath, 0o755);
    assert.notEqual(repository.git("status", "--porcelain=v2", "--", "selected.sh"), "");

    const result = await stash(repository, "selected.sh", "executable bit");

    assert.equal(treeMode(repository, result.stashSha, "selected.sh"), "100755");
    assert.equal(treeMode(repository, `${result.stashSha}^2`, "selected.sh"), "100644");
    assert.equal(filePermissions(selectedPath), 0o644);
    assert.equal(repository.git("status", "--porcelain=v2", "--", "selected.sh"), "");

    repository.git("stash", "apply", "--index", result.stashSha);

    assert.equal(filePermissions(selectedPath), 0o755);
    assert.equal(readFileSync(selectedPath, "utf8"), "#!/bin/sh\nexit 0\n");
  });

  test("fails closed for an actual split index", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    repository.git("update-index", "--split-index");
    assert.notEqual(
      repository.git("rev-parse", "--shared-index-path"),
      "",
      "The fixture must contain a real shared index file.",
    );
    const indexPath = join(repository.root, ".git", "index");
    const indexBefore = readFileSync(indexPath);
    write(repository, "selected.txt", "changed\n");

    await assert.rejects(stash(repository, "selected.txt", "split index"), /split index/iu);

    assert.equal(read(repository, "selected.txt"), "changed\n");
    assert.deepEqual(readFileSync(indexPath), indexBefore);
    assert.equal(resolveOptionalStash(repository), undefined);
  });

  test("accepts an ordinary repository below an aliased ancestor", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "refhaven-directory-boundary-"));
    roots.push(fixtureRoot);
    const targetRoot = join(fixtureRoot, "target");
    const repositoryRoot = join(targetRoot, "repository");
    const aliasRoot = join(fixtureRoot, "alias");
    mkdirSync(repositoryRoot, { recursive: true });
    symlinkSync(targetRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

    await assert.doesNotReject(
      assertOrdinaryDirectory(join(aliasRoot, "repository"), "Repository root"),
    );
    await assert.rejects(
      assertOrdinaryDirectory(aliasRoot, "Repository root"),
      /without symbolic links/iu,
    );
  });

  test("fails closed when a tracked path's parent is a symlink or junction", async () => {
    const repository = createRepository(roots, { "nested/selected.txt": "tracked base\n" });
    const outsideRoot = mkdtempSync(join(tmpdir(), "refhaven-stash-outside-"));
    roots.push(outsideRoot);
    const outsidePath = join(outsideRoot, "selected.txt");
    writeFileSync(outsidePath, "outside sentinel\n", "utf8");
    const indexBefore = readFileSync(join(repository.root, ".git", "index"));
    renameSync(join(repository.root, "nested"), join(repository.root, "nested-original"));
    symlinkSync(
      outsideRoot,
      join(repository.root, "nested"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      stash(repository, "nested/selected.txt", "symlink parent"),
      /symlink|regular file|worktree/iu,
    );

    assert.equal(readFileSync(outsidePath, "utf8"), "outside sentinel\n");
    assert.equal(lstatSync(join(repository.root, "nested")).isSymbolicLink(), true);
    assert.deepEqual(readFileSync(join(repository.root, ".git", "index")), indexBefore);
    assert.equal(resolveOptionalStash(repository), undefined);
  });

  test("rejects a case-only rename when both Git paths address one file", async function () {
    const repository = createRepository(roots, { "Selected.txt": "base\n" });
    repository.git("mv", "--", "Selected.txt", "temporary-name.txt");
    repository.git("mv", "--", "temporary-name.txt", "selected.txt");
    if (!existsSync(join(repository.root, "Selected.txt"))) this.skip();
    const indexPath = join(repository.root, ".git", "index");
    const indexBefore = readFileSync(indexPath);

    await assert.rejects(
      stash(repository, "selected.txt", "case-only rename", ["Selected.txt", "selected.txt"]),
      /case-only rename|same file/iu,
    );

    assert.equal(read(repository, "selected.txt"), "base\n");
    assert.deepEqual(readFileSync(indexPath), indexBefore);
    assert.equal(resolveOptionalStash(repository), undefined);
  });

  test("reports recovery directories until they are marked complete", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    const gitDirectory = repository.git("rev-parse", "--absolute-git-dir");
    const recoveryRoot = join(gitDirectory, "refhaven-recovery");
    const pendingDirectory = join(recoveryRoot, "stash-pending");
    const completeDirectory = join(recoveryRoot, "stash-complete");
    const unpreparedDirectory = join(recoveryRoot, "stash-unprepared");
    mkdirSync(pendingDirectory, { recursive: true });
    mkdirSync(completeDirectory, { recursive: true });
    mkdirSync(unpreparedDirectory, { recursive: true });
    writeFileSync(join(pendingDirectory, "journal-000-prepared.json"), "{}\n", "utf8");
    writeFileSync(join(completeDirectory, "journal-000-prepared.json"), "{}\n", "utf8");
    writeFileSync(join(completeDirectory, "journal-300-complete.json"), "{}\n", "utf8");
    writeFileSync(join(unpreparedDirectory, "journal-900-incomplete.json"), "{}\n", "utf8");

    const pending = await listPendingStashFileRecoveries(repository.root);

    assert.deepEqual(
      pending.map(({ directory }) => directory).sort(),
      [pendingDirectory, unpreparedDirectory].sort(),
    );
  });

  test("does not count completed safety-copy directories against the pending limit", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    const gitDirectory = repository.git("rev-parse", "--absolute-git-dir");
    const recoveryRoot = join(gitDirectory, "refhaven-recovery");
    const pendingDirectory = join(recoveryRoot, "stash-pending");
    mkdirSync(pendingDirectory, { recursive: true });

    for (let index = 0; index < 257; index += 1) {
      const completeDirectory = join(recoveryRoot, `stash-complete-${index.toString()}`);
      mkdirSync(completeDirectory);
      writeFileSync(join(completeDirectory, "journal-300-complete.json"), "{}\n", "utf8");
    }

    const pending = await listPendingStashFileRecoveries(repository.root);
    assert.deepEqual(pending, [{ directory: pendingDirectory }]);
  });

  test("fails closed when unfinished recovery records exceed the safety limit", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    const gitDirectory = repository.git("rev-parse", "--absolute-git-dir");
    const recoveryRoot = join(gitDirectory, "refhaven-recovery");
    for (let index = 0; index < 257; index += 1) {
      mkdirSync(join(recoveryRoot, `stash-pending-${index.toString()}`), { recursive: true });
    }

    await assert.rejects(
      listPendingStashFileRecoveries(repository.root),
      /too many unfinished recovery records/u,
    );
  });
});

interface RepositoryFixture {
  readonly git: (...args: readonly string[]) => string;
  readonly root: string;
}

function createRepository(
  roots: string[],
  files: Readonly<Record<string, Buffer | string>>,
): RepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), "refhaven-stash-security-"));
  roots.push(root);
  const repository: RepositoryFixture = {
    git: (...args) => gitBuffer(root, args).toString("utf8").trim(),
    root,
  };
  repository.git("init", "--initial-branch=main");
  repository.git("config", "user.name", "RefHaven Tests");
  repository.git("config", "user.email", "refhaven@example.invalid");
  repository.git("config", "core.autocrlf", "false");
  const disabledHooks = join(root, ".git", "hooks-disabled");
  mkdirSync(disabledHooks, { recursive: true });
  repository.git("config", "core.hooksPath", disabledHooks);
  for (const [filePath, contents] of Object.entries(files)) write(repository, filePath, contents);
  repository.git("add", "--all");
  repository.git("commit", "-m", "base");
  return repository;
}

function gitBuffer(root: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, { cwd: root, windowsHide: true });
}

function stash(
  repository: RepositoryFixture,
  filePath: string,
  message: string,
  pathspecs: readonly string[] = [filePath],
): Promise<StashFileResult> {
  return createPathLimitedStash({
    branchName: "main",
    headSha: repository.git("rev-parse", "HEAD"),
    message,
    pathspecs,
    repositoryRoot: repository.root,
  });
}

function write(repository: RepositoryFixture, filePath: string, contents: Buffer | string): void {
  const absolutePath = join(repository.root, ...filePath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function read(repository: RepositoryFixture, filePath: string): string {
  return readFileSync(join(repository.root, ...filePath.split("/")), "utf8");
}

function filePermissions(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

function treeMode(repository: RepositoryFixture, revision: string, filePath: string): string {
  const output = repository.git("ls-tree", revision, "--", filePath);
  assert.match(output, /^(100644|100755) blob [0-9a-f]+\t/u);
  return output.slice(0, 6);
}

function resolveOptionalStash(repository: RepositoryFixture): string | undefined {
  try {
    return repository.git("rev-parse", "--verify", "refs/stash");
  } catch {
    return undefined;
  }
}
