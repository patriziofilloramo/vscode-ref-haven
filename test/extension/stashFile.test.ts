import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  listChangedFilesForPath,
  listStashes,
  stashTrackedFile,
} from "../../src/infrastructure/git/GitCli";

suite("safe single-file stash", () => {
  const roots: string[] = [];

  teardown(() => {
    for (const root of roots.splice(0)) {
      try {
        rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
      } catch {
        // Best-effort cleanup under a unique temporary directory.
      }
    }
  });

  test("stashes only the selected tracked file and preserves unrelated index state", async () => {
    const repository = createRepository({
      "other-staged.txt": "base staged\n",
      "other-unstaged.txt": "base unstaged\n",
      "selected.txt": "base selected\n",
    });
    write(repository, "selected.txt", "selected change\n");
    write(repository, "other-staged.txt", "staged change\n");
    repository.git("add", "--", "other-staged.txt");
    write(repository, "other-unstaged.txt", "unstaged change\n");
    const stagedBefore = repository.git("diff", "--cached", "--binary", "--", "other-staged.txt");
    const unstagedBefore = repository.git("diff", "--binary", "--", "other-unstaged.txt");

    const stashSha = await stashTrackedFile(
      repository.root,
      "selected.txt",
      "RefHaven selected file",
    );

    assert.equal(read(repository, "selected.txt"), "base selected\n");
    assert.equal(read(repository, "other-staged.txt"), "staged change\n");
    assert.equal(read(repository, "other-unstaged.txt"), "unstaged change\n");
    assert.equal(
      repository.git("diff", "--cached", "--binary", "--", "other-staged.txt"),
      stagedBefore,
    );
    assert.equal(repository.git("diff", "--binary", "--", "other-unstaged.txt"), unstagedBefore);
    assert.equal(repository.git("show", `${stashSha}:selected.txt`), "selected change");
    const [stash] = await listStashes(repository.root);
    assert.ok(stash);
    assert.equal(stash.sha, stashSha);
    assert.equal(stash.branchName, "main");
    assert.equal(stash.message, "RefHaven selected file");
    const [stashedFile] = await listChangedFilesForPath(
      repository.root,
      stash.parentSha,
      stash.sha,
      "selected.txt",
    );
    assert.ok(stashedFile);
    assert.equal(stashedFile.newPath, "selected.txt");
    assert.equal(stashedFile.status, "modified");
  });

  test("preserves staged and unstaged versions of a partially staged file", async () => {
    const repository = createRepository({ "partial.txt": "base\n" });
    write(repository, "partial.txt", "staged\n");
    repository.git("add", "--", "partial.txt");
    write(repository, "partial.txt", "working tree\n");

    const stashSha = await stashTrackedFile(repository.root, "partial.txt", "partial state");

    assert.equal(read(repository, "partial.txt"), "base\n");
    assert.equal(repository.git("show", `${stashSha}^2:partial.txt`), "staged");
    assert.equal(repository.git("show", `${stashSha}:partial.txt`), "working tree");
    assert.equal(repository.git("status", "--porcelain=v2", "--", "partial.txt"), "");
    repository.git("stash", "apply", "--index", stashSha);
    assert.equal(repository.git("show", ":partial.txt"), "staged");
    assert.equal(read(repository, "partial.txt"), "working tree\n");
  });

  test("supports staged files, deletions, and renames", async () => {
    const stagedRepository = createRepository({ "staged.txt": "base\n" });
    write(stagedRepository, "staged.txt", "staged\n");
    stagedRepository.git("add", "--", "staged.txt");
    const stagedSha = await stashTrackedFile(stagedRepository.root, "staged.txt", "staged file");
    assert.equal(read(stagedRepository, "staged.txt"), "base\n");
    assert.equal(stagedRepository.git("show", `${stagedSha}^2:staged.txt`), "staged");

    const addedRepository = createRepository({ "existing.txt": "base\n" });
    write(addedRepository, "added.txt", "added\n");
    addedRepository.git("add", "--", "added.txt");
    const addedSha = await stashTrackedFile(addedRepository.root, "added.txt", "added file");
    assert.throws(() => read(addedRepository, "added.txt"));
    assert.equal(addedRepository.git("show", `${addedSha}:added.txt`), "added");
    addedRepository.git("stash", "apply", "--index", addedSha);
    assert.equal(read(addedRepository, "added.txt"), "added\n");

    const deletedRepository = createRepository({ "deleted.txt": "deleted\n" });
    unlinkSync(join(deletedRepository.root, "deleted.txt"));
    const deletedSha = await stashTrackedFile(
      deletedRepository.root,
      "deleted.txt",
      "deleted file",
    );
    assert.equal(read(deletedRepository, "deleted.txt"), "deleted\n");
    assert.throws(() => deletedRepository.git("cat-file", "-e", `${deletedSha}:deleted.txt`));
    deletedRepository.git("stash", "apply", "--index", deletedSha);
    assert.throws(() => read(deletedRepository, "deleted.txt"));

    const renamedRepository = createRepository({ "rename-old.txt": "renamed\n" });
    renameSync(
      join(renamedRepository.root, "rename-old.txt"),
      join(renamedRepository.root, "rename-new.txt"),
    );
    renamedRepository.git("add", "-A");
    const renamedSha = await stashTrackedFile(
      renamedRepository.root,
      "rename-new.txt",
      "renamed file",
    );
    assert.equal(read(renamedRepository, "rename-old.txt"), "renamed\n");
    assert.throws(() => read(renamedRepository, "rename-new.txt"));
    assert.equal(renamedRepository.git("show", `${renamedSha}:rename-new.txt`), "renamed");
    renamedRepository.git("stash", "apply", "--index", renamedSha);
    assert.throws(() => read(renamedRepository, "rename-old.txt"));
    assert.equal(read(renamedRepository, "rename-new.txt"), "renamed\n");
  });

  test("treats whitespace, Unicode, brackets, and nested paths literally", async () => {
    const nestedPath = "deep folder/another level/über file [1].txt";
    const longPath = `${Array.from(
      { length: 4 },
      (_, index) => `long-segment-${index.toString()}-abcdefghijkl`,
    ).join("/")}/long-file-name.txt`;
    const repository = createRepository({
      "[literal].txt": "brackets\n",
      "l.txt": "other\n",
      [longPath]: "long base\n",
      [nestedPath]: "base\n",
    });
    write(repository, nestedPath, "changed\n");

    const stashSha = await stashTrackedFile(repository.root, nestedPath, "Unicode path");

    assert.equal(read(repository, nestedPath), "base\n");
    assert.equal(read(repository, "l.txt"), "other\n");
    assert.equal(repository.git("show", `${stashSha}:${nestedPath}`), "changed");

    write(repository, "[literal].txt", "literal changed\n");
    const bracketSha = await stashTrackedFile(repository.root, "[literal].txt", "literal pathspec");
    assert.equal(read(repository, "[literal].txt"), "brackets\n");
    assert.equal(read(repository, "l.txt"), "other\n");
    assert.equal(repository.git("show", `${bracketSha}:[literal].txt`), "literal changed");

    write(repository, longPath, "long changed\n");
    const longSha = await stashTrackedFile(repository.root, longPath, "long path");
    assert.equal(read(repository, longPath), "long base\n");
    assert.equal(repository.git("show", `${longSha}:${longPath}`), "long changed");
  });

  test("works from a linked worktree", async () => {
    const repository = createRepository({ "worktree.txt": "base\n" });
    const linkedRoot = join(dirname(repository.root), "linked");
    repository.git("worktree", "add", "-b", "linked-test", linkedRoot);
    writeFileSync(join(linkedRoot, "worktree.txt"), "linked change\n", "utf8");

    const stashSha = await stashTrackedFile(linkedRoot, "worktree.txt", "linked worktree");

    assert.equal(readFileSync(join(linkedRoot, "worktree.txt"), "utf8"), "base\n");
    assert.equal(repository.git("show", `${stashSha}:worktree.txt`), "linked change");
  });

  test("does not execute repository hooks while creating or cleaning the stash", async () => {
    const repository = createRepository({ "hooked.txt": "base\n" });
    const markerPath = join(repository.root, "refhaven-hook-ran.txt");
    const hookPath = join(repository.root, ".git", "hooks", "reference-transaction");
    writeFileSync(hookPath, "#!/bin/sh\necho ran > refhaven-hook-ran.txt\n", "utf8");
    chmodSync(hookPath, 0o755);
    repository.git("update-ref", "refs/refhaven-hook-proof", "HEAD");
    assert.equal(existsSync(markerPath), true, "The fixture hook must be executable");
    unlinkSync(markerPath);
    write(repository, "hooked.txt", "changed\n");

    await stashTrackedFile(repository.root, "hooked.txt", "hooks disabled");

    assert.equal(existsSync(markerPath), false);
    assert.equal(read(repository, "hooked.txt"), "base\n");
  });

  test("rejects clean, untracked, and repository metadata paths without mutation", async () => {
    const repository = createRepository({ "tracked.txt": "base\n" });
    write(repository, "untracked.txt", "untracked\n");

    await assert.rejects(
      stashTrackedFile(repository.root, "tracked.txt", "clean"),
      /no tracked changes/u,
    );
    await assert.rejects(
      stashTrackedFile(repository.root, "untracked.txt", "untracked"),
      /no tracked changes/u,
    );
    await assert.rejects(stashTrackedFile(repository.root, ".git/config", "metadata"), /metadata/u);
    write(repository, ".gitattributes", "tracked.txt filter=external\n");
    write(repository, "tracked.txt", "filtered change\n");
    await assert.rejects(
      stashTrackedFile(repository.root, "tracked.txt", "filtered"),
      /content filter/u,
    );
    assert.equal(read(repository, "tracked.txt"), "filtered change\n");
    assert.equal(read(repository, "untracked.txt"), "untracked\n");
    assert.equal(repository.gitAllowFailure("rev-parse", "--verify", "refs/stash"), "");
  });

  interface RepositoryFixture {
    readonly git: (...args: string[]) => string;
    readonly gitAllowFailure: (...args: string[]) => string;
    readonly root: string;
  }

  function createRepository(files: Readonly<Record<string, string>>): RepositoryFixture {
    const container = join(
      tmpdir(),
      `refhaven-stash-tests-${process.pid.toString()}-${Date.now().toString()}-${roots.length.toString()}`,
    );
    const root = join(container, "main");
    roots.push(container);
    mkdirSync(root, { recursive: true });
    const runGit = (args: readonly string[]): string =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    const repository: RepositoryFixture = {
      git: (...args) => runGit(args),
      gitAllowFailure: (...args) => {
        try {
          return runGit(args);
        } catch {
          return "";
        }
      },
      root,
    };
    repository.git("init", "--initial-branch=main");
    repository.git("config", "user.name", "RefHaven Tests");
    repository.git("config", "user.email", "refhaven@example.invalid");
    repository.git("config", "core.autocrlf", "false");
    repository.git("config", "core.longpaths", "true");
    for (const [filePath, contents] of Object.entries(files)) write(repository, filePath, contents);
    repository.git("add", ".");
    repository.git("commit", "-m", "base");
    return repository;
  }

  function write(repository: RepositoryFixture, filePath: string, contents: string): void {
    const fullPath = join(repository.root, ...filePath.split("/"));
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents, "utf8");
  }

  function read(repository: RepositoryFixture, filePath: string): string {
    return readFileSync(join(repository.root, ...filePath.split("/")), "utf8");
  }
});
