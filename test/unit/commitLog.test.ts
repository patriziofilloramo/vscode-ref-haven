import assert from "node:assert/strict";

import {
  COMMIT_LOG_FORMAT,
  GitCommitLogParseError,
  parseCommitLog,
} from "../../src/infrastructure/git/commitLog";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NUL = "\0";

function record(sha: string, author: string, epoch: string, subject: string): string {
  return `${[sha, author, epoch, subject].join(NUL)}${NUL}`;
}

suite("parseCommitLog", () => {
  test("returns no commits for empty output", () => {
    assert.deepEqual(parseCommitLog(""), []);
  });

  test("declares a NUL-delimited format", () => {
    assert.equal(COMMIT_LOG_FORMAT, "%H%x00%an%x00%at%x00%s%x00");
  });

  test("parses records with sha, author, date, and subject", () => {
    const stdout = `${record(SHA_A, "Ada Lovelace", "1752480000", "feat: add engine")}\n${record(SHA_B, "Alan Turing", "1752390000", "fix: race")}\n`;

    const commits = parseCommitLog(stdout);

    assert.deepEqual(commits, [
      {
        authorDate: 1752480000000,
        authorName: "Ada Lovelace",
        sha: SHA_A,
        subject: "feat: add engine",
      },
      {
        authorDate: 1752390000000,
        authorName: "Alan Turing",
        sha: SHA_B,
        subject: "fix: race",
      },
    ]);
  });

  test("keeps subjects containing former record and field separators", () => {
    const commits = parseCommitLog(
      record(SHA_A, "Ada", "1752480000", "refactor\u001e: a\u001f -> b"),
    );

    assert.equal(commits[0]?.subject, "refactor\u001e: a\u001f -> b");
  });

  test("rejects records with an invalid sha", () => {
    assert.throws(
      () => parseCommitLog(record("not-a-sha", "Ada", "1752480000", "subject")),
      (error: unknown) =>
        error instanceof GitCommitLogParseError && !error.message.includes("not-a-sha"),
    );
    assert.throws(
      () => parseCommitLog(record(SHA_A, "Ada", "1752480000trailing", "subject")),
      GitCommitLogParseError,
    );
  });
});
