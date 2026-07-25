import assert from "node:assert/strict";

import { parseWorktreeStatus } from "../../src/infrastructure/git/worktreeStatus";

suite("worktree status parser", () => {
  test("counts staged, unstaged, renamed, conflicted, and untracked paths", () => {
    const output = [
      "# branch.oid abc",
      "1 M. N... 100644 100644 100644 a b staged.txt",
      "1 .M N... 100644 100644 100644 a b unstaged.txt",
      "2 RM N... 100644 100644 100644 a b R100 renamed.txt",
      "old-name.txt",
      "u UU N... 100644 100644 100644 100644 a b c conflicted.txt",
      "? new.txt",
      "",
    ].join("\0");

    assert.deepEqual(parseWorktreeStatus(output), {
      changedPaths: 5,
      conflicted: 1,
      staged: 2,
      unstaged: 2,
      untracked: 1,
    });
  });

  test("returns a clean state and rejects unknown records", () => {
    assert.deepEqual(parseWorktreeStatus("# branch.head main\0"), {
      changedPaths: 0,
      conflicted: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
    assert.throws(() => parseWorktreeStatus("x invalid\0"), /unknown worktree status/u);
    assert.throws(
      () => parseWorktreeStatus("2 R. N... 100644 100644 100644 a b R100 renamed.txt\0"),
      /truncated rename/u,
    );
  });
});
