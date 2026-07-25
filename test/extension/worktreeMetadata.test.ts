import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { resolveGitMetadataPaths } from "../../src/infrastructure/git/GitCli";

suite("worktree metadata discovery", () => {
  test("resolves both the worktree git-dir and shared common-dir", async () => {
    const fixtureRoot = join(
      tmpdir(),
      `refhaven-worktree-tests-${process.pid.toString()}-${Date.now().toString()}`,
    );
    const repositoryRoot = join(fixtureRoot, "repository");
    const worktreeRoot = join(fixtureRoot, "worktree");
    mkdirSync(repositoryRoot, { recursive: true });

    const git = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

    try {
      git(repositoryRoot, "init", "--initial-branch=main");
      git(repositoryRoot, "config", "user.name", "RefHaven Tests");
      git(repositoryRoot, "config", "user.email", "refhaven@example.invalid");
      writeFileSync(join(repositoryRoot, "tracked.txt"), "content\n", "utf8");
      git(repositoryRoot, "add", ".");
      git(repositoryRoot, "commit", "-m", "initial");
      git(repositoryRoot, "worktree", "add", "-b", "feature/worktree-test", worktreeRoot);

      const metadataPaths = (await resolveGitMetadataPaths(worktreeRoot)).map(normalize);
      const commonDir = normalize(join(repositoryRoot, ".git"));
      assert.ok(metadataPaths.includes(commonDir));
      assert.ok(metadataPaths.some((path) => path !== commonDir && path.includes("worktrees")));
    } finally {
      try {
        git(repositoryRoot, "worktree", "remove", "--force", worktreeRoot);
      } catch {
        // Best effort; the unique fixture directory is removed below.
      }
      try {
        rmSync(fixtureRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
      } catch {
        // Best-effort cleanup under the system temporary directory.
      }
    }
  });
});
