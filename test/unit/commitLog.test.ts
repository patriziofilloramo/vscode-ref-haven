import assert from "node:assert/strict";

import { GitCommitLogParseError, parseCommitLog } from "../../src/infrastructure/git/commitLog";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const FS = "";
const RS = "";

suite("parseCommitLog", () => {
  test("returns no commits for empty output", () => {
    assert.deepEqual(parseCommitLog(""), []);
  });

  test("parses records with sha, author, date, and subject", () => {
    const stdout = `${SHA_A}${FS}Ada Lovelace${FS}1752480000${FS}feat: add engine${RS}\n${SHA_B}${FS}Alan Turing${FS}1752390000${FS}fix: race${RS}\n`;

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

  test("keeps subjects containing separator-like plain text", () => {
    const commits = parseCommitLog(`${SHA_A}${FS}Ada${FS}1752480000${FS}refactor: a -> b${RS}`);

    assert.equal(commits[0]?.subject, "refactor: a -> b");
  });

  test("rejects records with an invalid sha", () => {
    assert.throws(
      () => parseCommitLog(`not-a-sha${FS}Ada${FS}1752480000${FS}subject${RS}`),
      GitCommitLogParseError,
    );
  });
});
