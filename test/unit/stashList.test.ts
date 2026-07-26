import assert from "node:assert/strict";

import {
  GitStashListParseError,
  STASH_LOG_FORMAT,
  parseStashList,
} from "../../src/infrastructure/git/stashList";

const NUL = "\0";
const STASH_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const INDEX_SHA = "c".repeat(40);
const UNTRACKED_SHA = "d".repeat(40);

function record(fields: {
  readonly epochSeconds?: string;
  readonly parents?: string;
  readonly selector?: string;
  readonly sha?: string;
  readonly subject?: string;
}): string {
  return [
    fields.selector ?? "stash@{0}",
    fields.sha ?? STASH_SHA,
    fields.parents ?? `${BASE_SHA} ${INDEX_SHA}`,
    fields.epochSeconds ?? "1700000000",
    fields.subject ?? "WIP on main: 1234abc base commit",
  ].join(NUL);
}

suite("Git stash list parser", () => {
  test("declares a format matching the parser expectations", () => {
    assert.equal(STASH_LOG_FORMAT, "%gd%x00%H%x00%P%x00%at%x00%gs%x00");
  });

  test("returns no entries for empty output", () => {
    assert.deepEqual(parseStashList(""), []);
  });

  test("parses a WIP stash and keeps the first parent", () => {
    const stashes = parseStashList(`${record({})}${NUL}`);

    assert.deepEqual(stashes, [
      {
        authorDate: 1_700_000_000_000,
        branchName: "main",
        message: "1234abc base commit",
        parentSha: BASE_SHA,
        selector: "stash@{0}",
        sha: STASH_SHA,
      },
    ]);
  });

  test("parses custom messages and untracked-file parents", () => {
    const stashes = parseStashList(
      `${record({
        parents: `${BASE_SHA} ${INDEX_SHA} ${UNTRACKED_SHA}`,
        subject: "On feature/x: my custom message",
      })}${NUL}`,
    );

    const stash = stashes[0];
    assert.ok(stash);
    assert.equal(stash.branchName, "feature/x");
    assert.equal(stash.message, "my custom message");
    assert.equal(stash.parentSha, BASE_SHA);
  });

  test("parses multiple newline-separated records", () => {
    const stashes = parseStashList(
      `${record({})}${NUL}\n${record({ selector: "stash@{1}", subject: "On (no branch): detached work" })}${NUL}\n`,
    );

    assert.equal(stashes.length, 2);
    const second = stashes[1];
    assert.ok(second);
    assert.equal(second.selector, "stash@{1}");
    assert.equal(second.branchName, undefined);
    assert.equal(second.message, "detached work");
  });

  test("keeps subjects without a reflog prefix as the message", () => {
    const stashes = parseStashList(`${record({ subject: "plain\u001e subject\u001f" })}${NUL}`);

    const stash = stashes[0];
    assert.ok(stash);
    assert.equal(stash.branchName, undefined);
    assert.equal(stash.message, "plain\u001e subject\u001f");
  });

  test("rejects malformed selectors, shas, parents, and dates", () => {
    assert.throws(
      () => parseStashList(`${record({ selector: "refs/stash" })}${NUL}`),
      GitStashListParseError,
    );
    assert.throws(
      () => parseStashList(`${record({ sha: "not-a-sha" })}${NUL}`),
      (error: unknown) =>
        error instanceof GitStashListParseError && !error.message.includes("not-a-sha"),
    );
    assert.throws(
      () => parseStashList(`${record({ parents: "short" })}${NUL}`),
      GitStashListParseError,
    );
    assert.throws(
      () => parseStashList(`${record({ epochSeconds: "1trailing" })}${NUL}`),
      GitStashListParseError,
    );
    assert.throws(() => parseStashList("stash@{0}"), GitStashListParseError);
  });
});
