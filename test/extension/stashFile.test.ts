import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
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
import {
  createPathLimitedStash,
  StashCleanupIncompleteError,
  type StashFileResult,
  type StashFileTestHooks,
} from "../../src/infrastructure/git/stashFile";

suite("fail-safe single-file stash", () => {
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

    const result = await stashTrackedFile(
      repository.root,
      "selected.txt",
      "RefHaven selected file",
    );
    const { stashSha } = result;

    assert.equal(read(repository, "selected.txt"), "base selected\n");
    assert.equal(read(repository, "other-staged.txt"), "staged change\n");
    assert.equal(read(repository, "other-unstaged.txt"), "unstaged change\n");
    assert.equal(
      repository.git("diff", "--cached", "--binary", "--", "other-staged.txt"),
      stagedBefore,
    );
    assert.equal(repository.git("diff", "--binary", "--", "other-unstaged.txt"), unstagedBefore);
    assert.equal(repository.git("show", `${stashSha}:selected.txt`), "selected change");
    assert.equal(readSafetyCopy(result, "selected.txt"), "selected change\n");
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

  test("uses a command-local technical identity when Git has no user identity", async () => {
    const repository = createRepository({ "selected.txt": "base\n" });
    repository.git("config", "user.name", "");
    repository.git("config", "user.email", "");
    write(repository, "selected.txt", "selected change\n");

    const { stashSha } = await stashTrackedFile(
      repository.root,
      "selected.txt",
      "identity fallback",
    );

    assert.equal(
      repository.git("show", "-s", "--format=%an <%ae>%n%cn <%ce>", stashSha),
      "RefHaven <refhaven@localhost.invalid>\nRefHaven <refhaven@localhost.invalid>",
    );
    assert.equal(repository.git("config", "--local", "--get", "user.name"), "");
    assert.equal(repository.git("config", "--local", "--get", "user.email"), "");
  });

  test("preserves staged and unstaged versions of a partially staged file", async () => {
    const repository = createRepository({ "partial.txt": "base\n" });
    write(repository, "partial.txt", "staged\n");
    repository.git("add", "--", "partial.txt");
    write(repository, "partial.txt", "working tree\n");

    const { stashSha } = await stashTrackedFile(repository.root, "partial.txt", "partial state");

    assert.equal(read(repository, "partial.txt"), "base\n");
    assert.equal(repository.git("show", `${stashSha}^2:partial.txt`), "staged");
    assert.equal(repository.git("show", `${stashSha}:partial.txt`), "working tree");
    assert.equal(repository.git("status", "--porcelain=v2", "--", "partial.txt"), "");
    repository.git("stash", "apply", "--index", stashSha);
    assert.equal(repository.git("show", ":partial.txt"), "staged");
    assert.equal(read(repository, "partial.txt"), "working tree\n");
  });

  test("supports staged files, additions, deletions, and renames", async () => {
    const stagedRepository = createRepository({ "staged.txt": "base\n" });
    write(stagedRepository, "staged.txt", "staged\n");
    stagedRepository.git("add", "--", "staged.txt");
    const { stashSha: stagedSha } = await stashTrackedFile(
      stagedRepository.root,
      "staged.txt",
      "staged file",
    );
    assert.equal(read(stagedRepository, "staged.txt"), "base\n");
    assert.equal(stagedRepository.git("show", `${stagedSha}^2:staged.txt`), "staged");

    const addedRepository = createRepository({ "existing.txt": "base\n" });
    write(addedRepository, "added.txt", "added\n");
    addedRepository.git("add", "--", "added.txt");
    const { stashSha: addedSha } = await stashTrackedFile(
      addedRepository.root,
      "added.txt",
      "added file",
    );
    assert.throws(() => read(addedRepository, "added.txt"));
    assert.equal(addedRepository.git("show", `${addedSha}:added.txt`), "added");
    addedRepository.git("stash", "apply", "--index", addedSha);
    assert.equal(read(addedRepository, "added.txt"), "added\n");

    const deletedRepository = createRepository({ "deleted.txt": "deleted\n" });
    unlinkSync(join(deletedRepository.root, "deleted.txt"));
    const { stashSha: deletedSha } = await stashTrackedFile(
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
    const { stashSha: renamedSha } = await stashTrackedFile(
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

    const { stashSha } = await stashTrackedFile(repository.root, nestedPath, "Unicode path");

    assert.equal(read(repository, nestedPath), "base\n");
    assert.equal(read(repository, "l.txt"), "other\n");
    assert.equal(repository.git("show", `${stashSha}:${nestedPath}`), "changed");

    write(repository, "[literal].txt", "literal changed\n");
    const { stashSha: bracketSha } = await stashTrackedFile(
      repository.root,
      "[literal].txt",
      "literal pathspec",
    );
    assert.equal(read(repository, "[literal].txt"), "brackets\n");
    assert.equal(read(repository, "l.txt"), "other\n");
    assert.equal(repository.git("show", `${bracketSha}:[literal].txt`), "literal changed");

    write(repository, longPath, "long changed\n");
    const { stashSha: longSha } = await stashTrackedFile(repository.root, longPath, "long path");
    assert.equal(read(repository, longPath), "long base\n");
    assert.equal(repository.git("show", `${longSha}:${longPath}`), "long changed");
  });

  test("works from a linked worktree", async () => {
    const repository = createRepository({ "worktree.txt": "base\n" });
    const linkedRoot = join(dirname(repository.root), "linked");
    repository.git("worktree", "add", "-b", "linked-test", linkedRoot);
    writeFileSync(join(linkedRoot, "worktree.txt"), "linked change\n", "utf8");

    const { stashSha } = await stashTrackedFile(linkedRoot, "worktree.txt", "linked worktree");

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

  test("rejects clean, untracked, metadata, and filtered paths without mutation", async () => {
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

  test("rejects an untracked replacement at a path whose deletion was staged", async () => {
    const repository = createRepository({ "selected.txt": "base\n" });
    repository.git("rm", "--", "selected.txt");
    write(repository, "selected.txt", "untracked replacement\n");

    await assert.rejects(
      stashTrackedFile(repository.root, "selected.txt", "staged deletion with replacement"),
      /replacement|untracked/iu,
    );

    assert.equal(repository.git("ls-files", "--stage", "--", "selected.txt"), "");
    assert.equal(read(repository, "selected.txt"), "untracked replacement\n");
    assert.equal(repository.gitAllowFailure("rev-parse", "--verify", "refs/stash"), "");
  });

  test("rejects a selected Git symlink without changing its bytes or index", async () => {
    const repository = createRepository({ "selected-link": "target-one\n" });
    const blob = repository.git("rev-parse", ":selected-link");
    repository.git("update-index", "--cacheinfo", `120000,${blob},selected-link`);
    repository.git("commit", "-m", "record symlink mode");
    write(repository, "selected-link", "target-two\n");
    const indexBefore = repository.git("ls-files", "--stage", "--", "selected-link");

    await assert.rejects(
      stashTrackedFile(repository.root, "selected-link", "symlink"),
      /unsupported|entry type/u,
    );

    assert.equal(read(repository, "selected-link"), "target-two\n");
    assert.equal(repository.git("ls-files", "--stage", "--", "selected-link"), indexBefore);
    assert.equal(repository.gitAllowFailure("rev-parse", "--verify", "refs/stash"), "");
  });

  test("rejects sparse checkout and sparse-index modes without mutation", async () => {
    const sparseCheckout = createRepository({ "selected.txt": "base\n" });
    sparseCheckout.git("sparse-checkout", "init", "--cone");
    write(sparseCheckout, "selected.txt", "sparse checkout change\n");

    await assert.rejects(
      stashTrackedFile(sparseCheckout.root, "selected.txt", "sparse checkout"),
      /sparse checkout/iu,
    );
    assert.equal(read(sparseCheckout, "selected.txt"), "sparse checkout change\n");
    assert.equal(sparseCheckout.git("show", ":selected.txt"), "base");
    assert.equal(sparseCheckout.gitAllowFailure("rev-parse", "--verify", "refs/stash"), "");

    const sparseIndex = createRepository({ "selected.txt": "base\n" });
    sparseIndex.git("config", "index.sparse", "true");
    write(sparseIndex, "selected.txt", "sparse index change\n");

    await assert.rejects(
      stashTrackedFile(sparseIndex.root, "selected.txt", "sparse index"),
      /sparse/iu,
    );
    assert.equal(read(sparseIndex, "selected.txt"), "sparse index change\n");
    assert.equal(sparseIndex.git("show", ":selected.txt"), "base");
    assert.equal(sparseIndex.gitAllowFailure("rev-parse", "--verify", "refs/stash"), "");
  });

  test("rejects a sparse file over the safety limit before creating a stash", async () => {
    const repository = createRepository({ "selected.bin": "base\n" });
    const selectedPath = join(repository.root, "selected.bin");
    const oversizedLength = 64 * 1024 * 1024 + 1;
    truncateSync(selectedPath, oversizedLength);

    await assert.rejects(
      stashTrackedFile(repository.root, "selected.bin", "oversized"),
      /too large/u,
    );

    assert.equal(statSync(selectedPath).size, oversizedLength);
    assert.equal(repository.git("show", ":selected.bin"), "base");
    assert.equal(repository.gitAllowFailure("rev-parse", "--verify", "refs/stash"), "");
  });

  test("preserves a concurrent worktree write detected before evacuation", async () => {
    const repository = createRepository({ "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured change\n");

    const error = await expectIncomplete(
      stashWithHooks(repository, ["selected.txt"], {
        beforeEvacuate: () => {
          write(repository, "selected.txt", "concurrent save\n");
        },
      }),
    );

    assert.equal(error.phase, "worktree");
    assert.equal(read(repository, "selected.txt"), "concurrent save\n");
    assert.equal(repository.git("show", `${error.stashSha}:selected.txt`), "captured change");
    assert.equal(readSafetyCopy(error, "selected.txt"), "concurrent save\n");
    assert.equal(repository.git("show", ":selected.txt"), "base");
  });

  test("never overwrites a concurrent worktree write created after evacuation", async () => {
    const repository = createRepository({ "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured change\n");

    const error = await expectIncomplete(
      stashWithHooks(repository, ["selected.txt"], {
        afterEvacuate: () => {
          write(repository, "selected.txt", "concurrent save\n");
        },
      }),
    );

    assert.equal(error.phase, "worktree");
    assert.equal(read(repository, "selected.txt"), "concurrent save\n");
    assert.equal(repository.git("show", `${error.stashSha}:selected.txt`), "captured change");
    assert.equal(readSafetyCopy(error, "selected.txt"), "captured change\n");
    assert.equal(repository.git("show", ":selected.txt"), "base");
  });

  test("never overwrites concurrent staged or worktree bytes during index cleanup", async () => {
    const repository = createRepository({ "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured staged\n");
    repository.git("add", "--", "selected.txt");
    write(repository, "selected.txt", "captured worktree\n");

    const error = await expectIncomplete(
      stashWithHooks(repository, ["selected.txt"], {
        beforeIndexCleanup: () => {
          write(repository, "selected.txt", "concurrent staged\n");
          repository.git("add", "--", "selected.txt");
          write(repository, "selected.txt", "concurrent worktree\n");
        },
      }),
    );

    assert.equal(error.phase, "index");
    assert.equal(repository.git("show", ":selected.txt"), "concurrent staged");
    assert.equal(read(repository, "selected.txt"), "concurrent worktree\n");
    assert.equal(repository.git("show", `${error.stashSha}^2:selected.txt`), "captured staged");
    assert.equal(repository.git("show", `${error.stashSha}:selected.txt`), "captured worktree");
    assert.equal(readSafetyCopy(error, "selected.txt"), "captured worktree\n");
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

  async function stashWithHooks(
    repository: RepositoryFixture,
    pathspecs: readonly string[],
    testHooks: StashFileTestHooks,
  ): Promise<StashFileResult> {
    return createPathLimitedStash({
      branchName: repository.git("branch", "--show-current"),
      headSha: repository.git("rev-parse", "HEAD"),
      message: "race regression",
      pathspecs,
      repositoryRoot: repository.root,
      testHooks,
    });
  }

  async function expectIncomplete(
    operation: Promise<StashFileResult>,
  ): Promise<StashCleanupIncompleteError> {
    try {
      await operation;
    } catch (error) {
      assert.ok(error instanceof StashCleanupIncompleteError);
      return error;
    }
    assert.fail("Expected fail-safe cleanup to stop with a recovery error.");
  }

  function readSafetyCopy(
    result: StashFileResult | StashCleanupIncompleteError,
    filePath: string,
  ): string {
    const recoveryDirectory = result.safetyCopyDirectory;
    assert.ok(recoveryDirectory, "Expected a retained safety-copy directory");
    const journal = JSON.parse(
      readFileSync(join(recoveryDirectory, "journal-000-prepared.json"), "utf8"),
    ) as { readonly paths?: readonly { readonly backup?: string; readonly filePath?: string }[] };
    const path = journal.paths?.find((entry) => entry.filePath === filePath);
    assert.ok(path?.backup, `Expected a safety-copy entry for ${filePath}`);
    return readFileSync(join(recoveryDirectory, path.backup), "utf8");
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
