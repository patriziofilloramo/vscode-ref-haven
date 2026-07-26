import assert from "node:assert/strict";

import {
  FILE_HISTORY_LOG_FORMAT,
  GitFileHistoryParseError,
  parseFileHistory,
} from "../../src/infrastructure/git/fileHistory";

const NUL = "\0";

function historyRecord(
  metadata: readonly [string, string, string, string, string],
  status: string,
  ...paths: readonly string[]
): string {
  return `${metadata.join(NUL)}${NUL}${NUL}\n${[status, ...paths].join(NUL)}${NUL}`;
}

suite("file history parser", () => {
  test("declares a NUL-delimited metadata format", () => {
    assert.equal(FILE_HISTORY_LOG_FORMAT, "%H%x00%P%x00%an%x00%at%x00%s%x00");
  });

  test("parses modified and renamed file history entries", () => {
    const firstSha = "1".repeat(40);
    const secondSha = "2".repeat(40);
    const parentSha = "0".repeat(40);
    const output =
      historyRecord([firstSha, parentSha, "Ada", "10", "modify\u001e\u001f"], "M", "src/new.ts") +
      historyRecord([secondSha, "", "Grace", "5", "rename"], "R100", "src/old.ts", "src/new.ts");

    const entries = parseFileHistory(output);

    assert.equal(entries.length, 2);
    const [modifiedEntry, renamedEntry] = entries;
    assert.ok(modifiedEntry);
    assert.ok(renamedEntry);
    assert.deepEqual(modifiedEntry, {
      change: { newPath: "src/new.ts", status: "modified" },
      commit: {
        authorDate: 10_000,
        authorName: "Ada",
        sha: firstSha,
        subject: "modify\u001e\u001f",
      },
      parentSha,
    });
    assert.deepEqual(renamedEntry.change, {
      newPath: "src/new.ts",
      oldPath: "src/old.ts",
      similarity: 100,
      status: "renamed",
    });
    assert.equal(renamedEntry.parentSha, null);
  });

  test("rejects malformed metadata and ambiguous change lists", () => {
    assert.throws(
      () => parseFileHistory(historyRecord(["bad", "", "Ada", "1", "subject"], "M", "src/file.ts")),
      GitFileHistoryParseError,
    );
    const sha = "1".repeat(40);
    assert.throws(
      () => parseFileHistory(`${[sha, "", "Ada", "1", "subject"].join(NUL)}${NUL}${NUL}`),
      GitFileHistoryParseError,
    );
    assert.throws(
      () => parseFileHistory(historyRecord([sha, "", "Ada", "1", "subject"], "X", "file.ts")),
      GitFileHistoryParseError,
    );
  });
});
