import assert from "node:assert/strict";

import type { FileChange } from "../../src/domain/comparisonResult";
import {
  GitNumstatParseError,
  mergeChangesWithStats,
  parseNumstatZ,
} from "../../src/infrastructure/git/numstat";

suite("parseNumstatZ", () => {
  test("returns no entries for empty output", () => {
    assert.deepEqual(parseNumstatZ(""), []);
  });

  test("parses plain additions and deletions", () => {
    const entries = parseNumstatZ("12\t3\tsrc/extension.ts\0");

    assert.deepEqual(entries, [{ additions: 12, deletions: 3, newPath: "src/extension.ts" }]);
  });

  test("parses binary changes as undefined counts", () => {
    const entries = parseNumstatZ("-\t-\tassets/logo.png\0");

    assert.deepEqual(entries, [{ newPath: "assets/logo.png" }]);
  });

  test("parses rename records that carry two extra path fields", () => {
    const entries = parseNumstatZ("5\t1\t\0src/old.ts\0src/new.ts\0");

    assert.deepEqual(entries, [
      { additions: 5, deletions: 1, newPath: "src/new.ts", oldPath: "src/old.ts" },
    ]);
  });

  test("parses mixed records in sequence", () => {
    const entries = parseNumstatZ("1\t0\ta.txt\0-\t-\tb.bin\0" + "2\t2\t\0c.ts\0d.ts\0");

    assert.equal(entries.length, 3);
    assert.deepEqual(entries[2], { additions: 2, deletions: 2, newPath: "d.ts", oldPath: "c.ts" });
  });

  test("rejects malformed records", () => {
    assert.throws(() => parseNumstatZ("not-numstat\0"), GitNumstatParseError);
  });
});

suite("mergeChangesWithStats", () => {
  test("attaches stats to matching changes by new path", () => {
    const changes: FileChange[] = [
      { newPath: "src/new.ts", oldPath: "src/old.ts", similarity: 90, status: "renamed" },
      { newPath: "assets/logo.png", status: "modified" },
    ];

    const merged = mergeChangesWithStats(changes, [
      { additions: 5, deletions: 1, newPath: "src/new.ts", oldPath: "src/old.ts" },
      { newPath: "assets/logo.png" },
    ]);

    assert.deepEqual(merged[0], {
      additions: 5,
      deletions: 1,
      newPath: "src/new.ts",
      oldPath: "src/old.ts",
      similarity: 90,
      status: "renamed",
    });
    assert.deepEqual(merged[1], { newPath: "assets/logo.png", status: "modified" });
  });
});
