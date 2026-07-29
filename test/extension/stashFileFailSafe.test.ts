import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
        // Best-effort cleanup below a unique temporary directory.
      }
    }
  });

  test("stashes a modified file and remains compatible with stash apply --index", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    write(repository, "selected.txt", "working change\n");

    const result = await stash(repository, "selected.txt", "modified file");

    assertPublishedStash(repository, result.stashSha);
    assertBytes(repository.show(`${result.stashSha}^1:selected.txt`), "base\n");
    assertBytes(repository.show(`${result.stashSha}^2:selected.txt`), "base\n");
    assertBytes(repository.show(`${result.stashSha}:selected.txt`), "working change\n");
    assertBytes(repository.show(":selected.txt"), "base\n");
    assertBytes(read(repository, "selected.txt"), "base\n");
    assertSafetyCopy(result, "working change\n");

    repository.git("stash", "apply", "--index", result.stashSha);

    assertBytes(repository.show(":selected.txt"), "base\n");
    assertBytes(read(repository, "selected.txt"), "working change\n");
  });

  test("leaves file and index untouched when refs/stash compare-and-swap loses", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured staged\n");
    repository.git("add", "--", "selected.txt");
    write(repository, "selected.txt", "captured working tree\n");
    const competingStashSha = repository.git("rev-parse", "HEAD");
    const indexPath = join(repository.root, ".git", "index");
    let candidateStashSha: string | undefined;
    let indexAtPublication: Buffer | undefined;
    let worktreeAtPublication: Buffer | undefined;

    await assert.rejects(
      stash(repository, "selected.txt", "stash ref race", {
        beforeStashRefUpdate: ({ stashSha }) => {
          candidateStashSha = stashSha;
          indexAtPublication = readFileSync(indexPath);
          worktreeAtPublication = read(repository, "selected.txt");
          repository.git("update-ref", "refs/stash", competingStashSha);
        },
      }),
      /another process changed the stash list/iu,
    );

    assert.ok(candidateStashSha);
    assert.notEqual(candidateStashSha, competingStashSha);
    assert.equal(repository.git("rev-parse", "--verify", "refs/stash"), competingStashSha);
    assert.equal(
      repository.git("for-each-ref", "--format=%(refname)", "refs/refhaven/stash-recovery"),
      "",
    );
    assert.deepEqual(readFileSync(indexPath), indexAtPublication);
    assert.deepEqual(read(repository, "selected.txt"), worktreeAtPublication);
    assertBytes(repository.show(":selected.txt"), "captured staged\n");
    assertBytes(read(repository, "selected.txt"), "captured working tree\n");
  });

  test("preserves newer content written immediately before evacuation", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured change\n");
    let hookStashSha: string | undefined;

    const error = await expectIncomplete(
      stash(repository, "selected.txt", "before evacuation", {
        beforeEvacuate: ({ stashSha }) => {
          hookStashSha = stashSha;
          write(repository, "selected.txt", "newer before evacuation\n");
        },
      }),
      "worktree",
    );

    assert.equal(error.stashSha, hookStashSha);
    assertPublishedStash(repository, error.stashSha);
    assertBytes(repository.show(`${error.stashSha}:selected.txt`), "captured change\n");
    assertBytes(repository.show(":selected.txt"), "base\n");
    assertBytes(read(repository, "selected.txt"), "newer before evacuation\n");
    assertBytes(
      readFileSync(join(error.safetyCopyDirectory, "evacuated-0")),
      "newer before evacuation\n",
    );
  });

  test("does not overwrite a path recreated after evacuation", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured change\n");

    const error = await expectIncomplete(
      stash(repository, "selected.txt", "after evacuation", {
        afterEvacuate: ({ safetyCopyDirectory }) => {
          assert.equal(existsSync(join(repository.root, "selected.txt")), false);
          assertBytes(readFileSync(join(safetyCopyDirectory, "evacuated-0")), "captured change\n");
          write(repository, "selected.txt", "recreated concurrently\n");
        },
      }),
      "worktree",
    );

    assertPublishedStash(repository, error.stashSha);
    assertBytes(repository.show(`${error.stashSha}:selected.txt`), "captured change\n");
    assertBytes(repository.show(":selected.txt"), "base\n");
    assertBytes(read(repository, "selected.txt"), "recreated concurrently\n");
    assertBytes(readFileSync(join(error.safetyCopyDirectory, "evacuated-0")), "captured change\n");
  });

  test("retains a newer staged state when index cleanup loses its compare-and-swap", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured staged\n");
    repository.git("add", "--", "selected.txt");
    write(repository, "selected.txt", "captured working tree\n");

    const error = await expectIncomplete(
      stash(repository, "selected.txt", "index race", {
        beforeIndexCleanup: ({ safetyCopyDirectory }) => {
          assertBytes(read(repository, "selected.txt"), "base\n");
          assertBytes(
            readFileSync(join(safetyCopyDirectory, "evacuated-0")),
            "captured working tree\n",
          );
          repository.setIndexBlob("selected.txt", Buffer.from("newer staged state\n", "utf8"));
        },
      }),
      "index",
    );

    assertPublishedStash(repository, error.stashSha);
    assertBytes(repository.show(`${error.stashSha}^2:selected.txt`), "captured staged\n");
    assertBytes(repository.show(`${error.stashSha}:selected.txt`), "captured working tree\n");
    assertBytes(repository.show(":selected.txt"), "newer staged state\n");
    assertBytes(read(repository, "selected.txt"), "base\n");
    assertBytes(
      readFileSync(join(error.safetyCopyDirectory, "evacuated-0")),
      "captured working tree\n",
    );
  });

  test("detects a new staged state even when the captured index matched HEAD", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured working tree\n");

    const error = await expectIncomplete(
      stash(repository, "selected.txt", "empty index patch race", {
        beforeIndexCleanup: () => {
          assertBytes(read(repository, "selected.txt"), "base\n");
          repository.setIndexBlob("selected.txt", Buffer.from("newly staged state\n", "utf8"));
        },
      }),
      "index",
    );

    assertPublishedStash(repository, error.stashSha);
    assertBytes(repository.show(`${error.stashSha}^2:selected.txt`), "base\n");
    assertBytes(repository.show(`${error.stashSha}:selected.txt`), "captured working tree\n");
    assertBytes(repository.show(":selected.txt"), "newly staged state\n");
    assertBytes(read(repository, "selected.txt"), "base\n");
  });

  test("detects and preserves a write after worktree cleanup", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured working tree\n");

    const error = await expectIncomplete(
      stash(repository, "selected.txt", "late worktree write", {
        afterWorktreeCleanup: () => {
          assertBytes(read(repository, "selected.txt"), "base\n");
          write(repository, "selected.txt", "written after cleanup\n");
        },
      }),
      "finalization",
    );

    assertPublishedStash(repository, error.stashSha);
    assertBytes(repository.show(`${error.stashSha}:selected.txt`), "captured working tree\n");
    assertBytes(repository.show(":selected.txt"), "base\n");
    assertBytes(read(repository, "selected.txt"), "written after cleanup\n");
    assertBytes(
      readFileSync(join(error.safetyCopyDirectory, "evacuated-0")),
      "captured working tree\n",
    );
  });

  test("detects and preserves a staged write after atomic index cleanup", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured working tree\n");

    const error = await expectIncomplete(
      stash(repository, "selected.txt", "late index write", {
        afterIndexCleanup: () => {
          repository.setIndexBlob("selected.txt", Buffer.from("staged after cleanup\n", "utf8"));
        },
      }),
      "finalization",
    );

    assertPublishedStash(repository, error.stashSha);
    assertBytes(repository.show(`${error.stashSha}:selected.txt`), "captured working tree\n");
    assertBytes(repository.show(":selected.txt"), "staged after cleanup\n");
    assertBytes(read(repository, "selected.txt"), "base\n");
  });

  test("retains a private recovery ref when the stash list is cleared concurrently", async () => {
    const repository = createRepository(roots, { "selected.txt": "base\n" });
    write(repository, "selected.txt", "captured working tree\n");

    const error = await expectIncomplete(
      stash(repository, "selected.txt", "concurrent stash clear", {
        beforeEvacuate: () => {
          repository.git("stash", "clear");
        },
      }),
      "finalization",
    );

    const recoveryRefs = repository.git(
      "for-each-ref",
      "--format=%(objectname)",
      "refs/refhaven/stash-recovery",
    );
    assert.equal(recoveryRefs, error.stashSha);
    assertBytes(repository.show(`${error.stashSha}:selected.txt`), "captured working tree\n");
    assertBytes(repository.show(":selected.txt"), "base\n");
    assertBytes(read(repository, "selected.txt"), "base\n");
  });

  test("round-trips partially staged CRLF content byte for byte", async () => {
    const base = Buffer.from("base\r\nsecond line\r\n", "utf8");
    const staged = Buffer.from("staged\r\nsecond line\r\n", "utf8");
    const working = Buffer.from("working\r\nsecond line\r\n", "utf8");
    const repository = createRepository(roots, { "selected.txt": base });
    write(repository, "selected.txt", staged);
    repository.git("add", "--", "selected.txt");
    write(repository, "selected.txt", working);

    const result = await stash(repository, "selected.txt", "CRLF state");

    assertBytes(repository.show(`${result.stashSha}^2:selected.txt`), staged);
    assertBytes(repository.show(`${result.stashSha}:selected.txt`), working);
    assertBytes(repository.show(":selected.txt"), base);
    assertBytes(read(repository, "selected.txt"), base);

    repository.git("stash", "apply", "--index", result.stashSha);

    assertBytes(repository.show(":selected.txt"), staged);
    assertBytes(read(repository, "selected.txt"), working);
  });

  test("round-trips CRLF worktree conversion with normalized Git blobs", async () => {
    const repository = createRepository(roots, {
      ".gitattributes": "*.txt text eol=crlf\n",
      "selected.txt": "base\nsecond line\n",
    });
    const baseWorktree = Buffer.from("base\r\nsecond line\r\n", "utf8");
    const stagedWorktree = Buffer.from("staged\r\nsecond line\r\n", "utf8");
    const working = Buffer.from("working\r\nsecond line\r\n", "utf8");
    rmSync(join(repository.root, "selected.txt"));
    repository.git("checkout", "--", "selected.txt");
    assert.equal(repository.git("status", "--porcelain=v2", "--", "selected.txt"), "");
    assertBytes(read(repository, "selected.txt"), baseWorktree);
    write(repository, "selected.txt", stagedWorktree);
    repository.git("add", "--", "selected.txt");
    write(repository, "selected.txt", working);

    const result = await stash(repository, "selected.txt", "converted CRLF state");

    assertBytes(repository.show(`${result.stashSha}^2:selected.txt`), "staged\nsecond line\n");
    assertBytes(repository.show(`${result.stashSha}:selected.txt`), "working\nsecond line\n");
    assertBytes(repository.show(":selected.txt"), "base\nsecond line\n");
    assertBytes(read(repository, "selected.txt"), baseWorktree);

    repository.git("stash", "apply", "--index", result.stashSha);

    assertBytes(repository.show(":selected.txt"), "staged\nsecond line\n");
    assertBytes(read(repository, "selected.txt"), working);
  });

  test("round-trips partially staged binary content byte for byte", async () => {
    const base = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    const staged = Buffer.from([0x00, 0x01, 0x09, 0x03, 0xff]);
    const working = Buffer.from([0x00, 0x07, 0x09, 0x03, 0xff, 0x00]);
    const repository = createRepository(roots, { "selected.bin": base });
    write(repository, "selected.bin", staged);
    repository.git("add", "--", "selected.bin");
    write(repository, "selected.bin", working);

    const result = await stash(repository, "selected.bin", "binary state");

    assertBytes(repository.show(`${result.stashSha}^2:selected.bin`), staged);
    assertBytes(repository.show(`${result.stashSha}:selected.bin`), working);
    assertBytes(repository.show(":selected.bin"), base);
    assertBytes(read(repository, "selected.bin"), base);

    repository.git("stash", "apply", "--index", result.stashSha);

    assertBytes(repository.show(":selected.bin"), staged);
    assertBytes(read(repository, "selected.bin"), working);
  });
});

interface RepositoryFixture {
  readonly git: (...args: readonly string[]) => string;
  readonly root: string;
  readonly setIndexBlob: (filePath: string, contents: Buffer) => void;
  readonly show: (revisionAndPath: string) => Buffer;
}

function createRepository(
  roots: string[],
  files: Readonly<Record<string, Buffer | string>>,
): RepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), "refhaven-fail-safe-stash-"));
  roots.push(root);
  const git = (...args: readonly string[]): string => gitBuffer(root, args).toString("utf8").trim();
  const repository: RepositoryFixture = {
    git,
    root,
    setIndexBlob: (filePath, contents) => {
      const objectId = gitBuffer(root, ["hash-object", "-w", "--stdin"], contents)
        .toString("utf8")
        .trim();
      git("update-index", "--add", "--cacheinfo", `100644,${objectId},${filePath}`);
    },
    show: (revisionAndPath) => gitBuffer(root, ["show", revisionAndPath]),
  };
  repository.git("init", "--initial-branch=main");
  repository.git("config", "user.name", "RefHaven Tests");
  repository.git("config", "user.email", "refhaven@example.invalid");
  repository.git("config", "core.autocrlf", "false");
  repository.git("config", "core.filemode", "false");
  const disabledHooks = join(root, ".git", "hooks-disabled");
  mkdirSync(disabledHooks, { recursive: true });
  repository.git("config", "core.hooksPath", disabledHooks);
  for (const [filePath, contents] of Object.entries(files)) write(repository, filePath, contents);
  repository.git("add", "--all");
  repository.git("commit", "-m", "base");
  return repository;
}

function stash(
  repository: RepositoryFixture,
  filePath: string,
  message: string,
  testHooks?: StashFileTestHooks,
): Promise<StashFileResult> {
  return createPathLimitedStash({
    branchName: "main",
    headSha: repository.git("rev-parse", "HEAD"),
    message,
    pathspecs: [filePath],
    repositoryRoot: repository.root,
    ...(testHooks ? { testHooks } : {}),
  });
}

async function expectIncomplete(
  operation: Promise<StashFileResult>,
  phase: StashCleanupIncompleteError["phase"],
): Promise<StashCleanupIncompleteError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof StashCleanupIncompleteError);
    assert.equal(error.phase, phase);
    assert.ok(error.stashSha.length > 0);
    assert.equal(existsSync(error.safetyCopyDirectory), true);
    return error;
  }
  throw new Error("Expected the stash cleanup to stop safely.");
}

function assertPublishedStash(repository: RepositoryFixture, stashSha: string): void {
  assert.equal(repository.git("rev-parse", "--verify", "refs/stash"), stashSha);
  assert.equal(repository.git("stash", "list", "--format=%H"), stashSha);
}

function assertSafetyCopy(result: StashFileResult, expected: Buffer | string): void {
  assert.ok(result.safetyCopyDirectory);
  assertBytes(readFileSync(join(result.safetyCopyDirectory, "evacuated-0")), expected);
}

function gitBuffer(root: string, args: readonly string[], input?: Buffer): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    ...(input ? { input } : {}),
    windowsHide: true,
  });
}

function write(repository: RepositoryFixture, filePath: string, contents: Buffer | string): void {
  const absolutePath = join(repository.root, ...filePath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function read(repository: RepositoryFixture, filePath: string): Buffer {
  return readFileSync(join(repository.root, ...filePath.split("/")));
}

function assertBytes(actual: Buffer, expected: Buffer | string): void {
  assert.deepEqual(actual, typeof expected === "string" ? Buffer.from(expected, "utf8") : expected);
}
