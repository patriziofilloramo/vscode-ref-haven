import assert from "node:assert/strict";

import {
  assertValidCommitSearchQuery,
  buildCommitSearchCriteria,
} from "../../src/infrastructure/git/commitSearch";

suite("commit search query", () => {
  test("builds explicit literal and regex message criteria", () => {
    assert.deepEqual(
      buildCommitSearchCriteria({
        caseSensitive: false,
        kind: "message",
        patternMode: "literal",
        text: "fix.*",
      }),
      ["--fixed-strings", "--regexp-ignore-case", "--grep=fix.*"],
    );
    assert.deepEqual(
      buildCommitSearchCriteria({
        caseSensitive: true,
        kind: "message",
        patternMode: "regex",
        text: "fix(es)?",
      }),
      ["--extended-regexp", "--grep=fix(es)?"],
    );
  });

  test("escapes literal author and content patterns without changing regex patterns", () => {
    assert.deepEqual(
      buildCommitSearchCriteria({
        caseSensitive: false,
        kind: "author",
        patternMode: "literal",
        text: "Pat [bot].*",
      }),
      ["--extended-regexp", "--regexp-ignore-case", "--author=Pat \\[bot\\]\\.\\*"],
    );
    assert.deepEqual(
      buildCommitSearchCriteria({
        caseSensitive: true,
        kind: "content",
        patternMode: "literal",
        text: "call(value);",
      }),
      ["-Gcall\\(value\\);", "--pickaxe-all"],
    );
    assert.deepEqual(
      buildCommitSearchCriteria({
        caseSensitive: false,
        kind: "content",
        patternMode: "regex",
        text: "call\\((old|new)\\)",
      }),
      ["--regexp-ignore-case", "-Gcall\\((old|new)\\)", "--pickaxe-all"],
    );
  });

  test("validates bounded queries and hexadecimal SHA prefixes", () => {
    assert.doesNotThrow(() => assertValidCommitSearchQuery({ kind: "sha", text: "a1b2c3d4" }));
    assert.throws(
      () => assertValidCommitSearchQuery({ kind: "sha", text: "not-a-sha" }),
      /SHA prefix is invalid/u,
    );
    assert.throws(
      () =>
        assertValidCommitSearchQuery({
          caseSensitive: false,
          kind: "message",
          patternMode: "literal",
          text: "",
        }),
      /query is invalid/u,
    );
  });
});
