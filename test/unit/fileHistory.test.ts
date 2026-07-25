import assert from "node:assert/strict";

import {
  FILE_HISTORY_LOG_FORMAT,
  GitFileHistoryParseError,
  parseFileHistory,
} from "../../src/infrastructure/git/fileHistory";

suite("file history parser", () => {
  test("declares a format with explicit record and metadata separators", () => {
    assert.equal(FILE_HISTORY_LOG_FORMAT, "%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s");
  });

  test("parses modified and renamed file history entries", () => {
    const firstSha = "1".repeat(40);
    const secondSha = "2".repeat(40);
    const parentSha = "0".repeat(40);
    const output =
      `\u001e${firstSha}\u001f${parentSha}\u001fAda\u001f10\u001fmodify\0M\0src/new.ts\0` +
      `\u001e${secondSha}\u001f\u001fGrace\u001f5\u001frename\0R100\0src/old.ts\0src/new.ts\0`;

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
        subject: "modify",
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
    assert.throws(() => parseFileHistory("\u001ebad\0M\0src/file.ts\0"), GitFileHistoryParseError);
    const sha = "1".repeat(40);
    assert.throws(
      () => parseFileHistory(`\u001e${sha}\u001f\u001fAda\u001f1\u001fsubject\0`),
      GitFileHistoryParseError,
    );
  });
});
