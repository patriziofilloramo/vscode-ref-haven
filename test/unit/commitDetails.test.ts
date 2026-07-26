import assert from "node:assert/strict";

import {
  COMMIT_DETAILS_FORMAT,
  parseCommitDetails,
} from "../../src/infrastructure/git/commitDetails";

suite("commit details parser", () => {
  test("uses NUL delimiters and preserves the full message", () => {
    assert.match(COMMIT_DETAILS_FORMAT, /%x00/u);
    const sha = "1".repeat(40);
    const parent = "2".repeat(40);
    const details = parseCommitDetails(
      [
        sha,
        parent,
        "Ada",
        "ada@example.invalid",
        "10",
        "Grace",
        "grace@example.invalid",
        "20",
        "Subject\n\nBody",
        "",
      ].join("\0"),
    );
    assert.equal(details.commit.subject, "Subject");
    assert.equal(details.fullMessage, "Subject\n\nBody");
    assert.deepEqual(details.parentShas, [parent]);
    assert.equal(details.committerDate, 20_000);
  });

  test("rejects invalid identities and timestamps", () => {
    assert.throws(() =>
      parseCommitDetails(
        ["bad", "", "Ada", "a@b", "1", "Grace", "g@b", "2", "message", ""].join("\0"),
      ),
    );
    const sha = "1".repeat(40);
    assert.throws(() =>
      parseCommitDetails(
        [sha, "", "Ada", "a@b", "1trailing", "Grace", "g@b", "2", "message", ""].join("\0"),
      ),
    );
  });
});
