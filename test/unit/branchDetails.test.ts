import assert from "node:assert/strict";

import {
  BRANCH_DETAILS_FORMAT,
  parseBranchDetails,
} from "../../src/infrastructure/git/branchDetails";

suite("branch details parser", () => {
  test("parses local and remote branch metadata with tracking state", () => {
    const localSha = "a".repeat(40);
    const remoteSha = "b".repeat(40);
    const output =
      [
        "refs/heads/main",
        "main",
        localSha,
        "origin/main",
        "[ahead 2, behind 3]",
        "Ada",
        "10",
        "local subject",
      ].join("\0") +
      "\0\n" +
      [
        "refs/remotes/origin/main",
        "origin/main",
        remoteSha,
        "",
        "",
        "Grace",
        "5",
        "remote subject",
      ].join("\0") +
      "\0\n";

    assert.deepEqual(parseBranchDetails(output), [
      {
        ahead: 2,
        behind: 3,
        branch: { displayName: "main", fullName: "refs/heads/main", kind: "localBranch" },
        latestCommit: {
          authorDate: 10_000,
          authorName: "Ada",
          sha: localSha,
          subject: "local subject",
        },
        sha: localSha,
        upstream: "origin/main",
        upstreamGone: false,
      },
      {
        ahead: 0,
        behind: 0,
        branch: {
          displayName: "origin/main",
          fullName: "refs/remotes/origin/main",
          kind: "remoteBranch",
        },
        latestCommit: {
          authorDate: 5_000,
          authorName: "Grace",
          sha: remoteSha,
          subject: "remote subject",
        },
        sha: remoteSha,
        upstreamGone: false,
      },
    ]);
  });

  test("parses gone upstreams and rejects malformed records", () => {
    const sha = "c".repeat(40);
    const [branch] = parseBranchDetails(
      ["refs/heads/topic", "topic", sha, "origin/topic", "[gone]", "Ada", "1", "subject"].join(
        "\0",
      ) + "\0\n",
    );
    assert.ok(branch);
    assert.equal(branch.upstreamGone, true);
    assert.throws(() => parseBranchDetails("refs/heads/main\0main\0bad\0"), /malformed/u);
    assert.throws(
      () =>
        parseBranchDetails(
          ["refs/heads/main", "main", sha, "", "", "Ada", "1trailing", "subject"].join("\0") +
            "\0\n",
        ),
      /date/u,
    );
    assert.match(BRANCH_DETAILS_FORMAT, /upstream:track/u);
  });

  test("ignores the remote HEAD symbolic reference without hiding local HEAD", () => {
    const sha = "d".repeat(40);
    const output =
      ["refs/remotes/origin/HEAD", "origin/HEAD", sha, "", "", "Ada", "1", "remote head"].join(
        "\0",
      ) +
      "\0\n" +
      ["refs/heads/HEAD", "HEAD", sha, "", "", "Ada", "1", "local head"].join("\0") +
      "\0\n";
    assert.deepEqual(
      parseBranchDetails(output).map(({ branch }) => branch.fullName),
      ["refs/heads/HEAD"],
    );
  });
});
