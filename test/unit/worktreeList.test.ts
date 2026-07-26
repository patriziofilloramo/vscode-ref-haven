import assert from "node:assert/strict";

import { parseWorktreeList } from "../../src/infrastructure/git/worktreeList";

suite("Git worktree porcelain parser", () => {
  test("parses branch, detached, locked, and prunable records", () => {
    const sha = "a".repeat(40);
    const otherSha = "b".repeat(40);
    const output = [
      "worktree C:/repo",
      `HEAD ${sha}`,
      "branch refs/heads/main",
      "",
      "worktree C:/repo-linked",
      `HEAD ${otherSha}`,
      "detached",
      "locked administrative reason",
      "prunable missing directory",
      "",
      "",
    ].join("\0");

    assert.deepEqual(parseWorktreeList(output), [
      {
        bare: false,
        branchFullName: "refs/heads/main",
        detached: false,
        headSha: sha,
        locked: false,
        path: "C:/repo",
      },
      {
        bare: false,
        detached: true,
        headSha: otherSha,
        locked: true,
        lockedReason: "administrative reason",
        path: "C:/repo-linked",
        prunableReason: "missing directory",
      },
    ]);
  });

  test("rejects incomplete and non-local branch metadata", () => {
    assert.throws(() => parseWorktreeList("worktree C:/repo\0\0"), /invalid worktree/u);
    assert.throws(
      () =>
        parseWorktreeList(
          `worktree C:/repo\0HEAD ${"a".repeat(40)}\0branch refs/remotes/origin/main\0\0`,
        ),
      /invalid worktree branch/u,
    );
    assert.throws(
      () =>
        parseWorktreeList(
          `worktree C:/repo\0HEAD ${"a".repeat(40)}\0private-key first\0private-key second\0\0`,
        ),
      (error: unknown) => error instanceof Error && !error.message.includes("private-key"),
    );
  });
});
