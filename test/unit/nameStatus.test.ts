import assert from "node:assert/strict";

import {
  GitNameStatusParseError,
  nameStatusPathCount,
  parseNameStatusZ,
} from "../../src/infrastructure/git/nameStatus";

suite("Git name-status parser", () => {
  test("parses NUL-delimited add, modify, delete, rename, copy, and type changes", () => {
    const output = [
      "A",
      "added file.txt",
      "M",
      "folder/with\ttab.ts",
      "D",
      "deleted.txt",
      "R087",
      "old\nname.txt",
      "new\nname.txt",
      "C100",
      "source.txt",
      "copy.txt",
      "T",
      "link",
      "",
    ].join("\0");

    assert.deepEqual(parseNameStatusZ(output), [
      { newPath: "added file.txt", status: "added" },
      { newPath: "folder/with\ttab.ts", status: "modified" },
      { newPath: "deleted.txt", status: "deleted" },
      {
        newPath: "new\nname.txt",
        oldPath: "old\nname.txt",
        similarity: 87,
        status: "renamed",
      },
      {
        newPath: "copy.txt",
        oldPath: "source.txt",
        similarity: 100,
        status: "copied",
      },
      { newPath: "link", status: "typeChanged" },
    ]);
  });

  test("accepts empty output and unmerged states", () => {
    assert.deepEqual(parseNameStatusZ(""), []);
    assert.deepEqual(parseNameStatusZ("UU\0conflicted.txt\0"), [
      { newPath: "conflicted.txt", status: "unmerged" },
    ]);
  });

  test("derives path cardinality from the same validated status parser", () => {
    assert.equal(nameStatusPathCount("M"), 1);
    assert.equal(nameStatusPathCount("UU"), 1);
    assert.equal(nameStatusPathCount("R087"), 2);
    assert.equal(nameStatusPathCount("C"), 2);
    assert.throws(() => nameStatusPathCount("X"), GitNameStatusParseError);
  });

  test("rejects unknown and truncated records", () => {
    assert.throws(
      () => parseNameStatusZ("X-private-status\0file.txt\0"),
      (error: unknown) =>
        error instanceof GitNameStatusParseError && !error.message.includes("private-status"),
    );
    assert.throws(() => parseNameStatusZ("M100\0file.txt\0"), GitNameStatusParseError);
    assert.throws(() => parseNameStatusZ("R100\0old.txt\0"), GitNameStatusParseError);
    assert.throws(() => parseNameStatusZ("M\0"), GitNameStatusParseError);
  });

  test("rejects traversal paths on every host", () => {
    for (const output of ["M\0../outside.txt\0", "R100\0safe.txt\0../outside.txt\0"]) {
      assert.throws(() => parseNameStatusZ(output), GitNameStatusParseError);
    }
  });

  test("applies Windows filename restrictions only on Windows", () => {
    for (const path of ["NUL.txt", "safe.txt:alternate-stream"]) {
      const output = `M\0${path}\0`;
      if (process.platform === "win32") {
        assert.throws(() => parseNameStatusZ(output), GitNameStatusParseError);
      } else {
        assert.deepEqual(parseNameStatusZ(output), [{ newPath: path, status: "modified" }]);
      }
    }
  });
});
