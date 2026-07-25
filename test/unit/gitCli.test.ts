import assert from "node:assert/strict";

import { parseBranchRefs, parseComparisonRefs } from "../../src/infrastructure/git/branchRefs";

suite("GitCli branch parsing", () => {
  test("parses local and remote branch refs from git for-each-ref output", () => {
    assert.deepEqual(
      parseBranchRefs(
        [
          "refs/heads/main\tmain",
          "refs/heads/feature/oauth\tfeature/oauth",
          "refs/remotes/origin/main\torigin/main",
          "refs/remotes/origin/HEAD\torigin/HEAD",
          "",
        ].join("\n"),
      ),
      [
        {
          displayName: "feature/oauth",
          fullName: "refs/heads/feature/oauth",
          kind: "localBranch",
        },
        {
          displayName: "main",
          fullName: "refs/heads/main",
          kind: "localBranch",
        },
        {
          displayName: "origin/main",
          fullName: "refs/remotes/origin/main",
          kind: "remoteBranch",
        },
      ],
    );
  });

  test("ignores malformed rows and non-branch refs", () => {
    assert.deepEqual(
      parseBranchRefs(
        ["refs/tags/v1\tv1", "missing-display-name", "refs/heads/dev\tdev"].join("\n"),
      ),
      [
        {
          displayName: "dev",
          fullName: "refs/heads/dev",
          kind: "localBranch",
        },
      ],
    );
  });

  test("includes tags when parsing comparison references", () => {
    assert.deepEqual(parseComparisonRefs("refs/tags/v1.0\tv1.0\n"), [
      { displayName: "v1.0", fullName: "refs/tags/v1.0", kind: "tag" },
    ]);
  });
});
