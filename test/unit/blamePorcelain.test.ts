import assert from "node:assert/strict";

import {
  GitBlameParseError,
  parseBlameFilePorcelain,
  parseBlamePorcelain,
} from "../../src/infrastructure/git/blamePorcelain";

const SHA = "a".repeat(40);
const ZERO_SHA = "0".repeat(40);

function porcelain(sha: string, overrides: Readonly<Record<string, string | null>> = {}): string {
  const metadata: Record<string, string | null> = {
    author: "Patrizio Filloramo",
    "author-mail": "<patrizio@example.invalid>",
    "author-time": "1700000000",
    "author-tz": "+0100",
    summary: "feat: add blame support",
    filename: "src/example.ts",
    ...overrides,
  };
  const lines = [`${sha} 3 3 1`];
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== null) lines.push(`${key} ${value}`);
  }
  lines.push("\tconst example = 1;");
  return `${lines.join("\n")}\n`;
}

suite("Git blame porcelain parser", () => {
  test("returns null for empty output", () => {
    assert.equal(parseBlamePorcelain(""), null);
  });

  test("parses a committed line", () => {
    const blame = parseBlamePorcelain(porcelain(SHA));

    assert.deepEqual(blame, {
      authorDate: 1_700_000_000_000,
      authorName: "Patrizio Filloramo",
      isCommitted: true,
      path: "src/example.ts",
      sha: SHA,
      summary: "feat: add blame support",
    });
  });

  test("treats an all-zero SHA as uncommitted and drops the placeholder summary", () => {
    const blame = parseBlamePorcelain(
      porcelain(ZERO_SHA, { author: "Not Committed Yet", summary: "Version of src/example.ts" }),
    );

    assert.ok(blame);
    assert.equal(blame.isCommitted, false);
    assert.equal(blame.summary, "");
    assert.equal(blame.authorName, "Not Committed Yet");
  });

  test("accepts headers without a line-count field and boundary markers", () => {
    const output = porcelain(SHA).replace(`${SHA} 3 3 1`, `${SHA} 3 3\nboundary`);
    const blame = parseBlamePorcelain(output);

    assert.ok(blame);
    assert.equal(blame.sha, SHA);
  });

  test("rejects malformed headers and missing metadata", () => {
    assert.throws(() => parseBlamePorcelain("not a blame header\n"), GitBlameParseError);
    assert.throws(
      () => parseBlamePorcelain(porcelain(SHA, { "author-time": null })),
      GitBlameParseError,
    );
    assert.throws(
      () => parseBlamePorcelain(porcelain(SHA, { filename: null })),
      GitBlameParseError,
    );
    assert.throws(
      () => parseBlamePorcelain(porcelain(SHA, { "author-time": "yesterday" })),
      GitBlameParseError,
    );
  });

  test("parses repeated line-porcelain records in final-line order", () => {
    const second = porcelain(SHA).replace(`${SHA} 3 3 1`, `${SHA} 4 2 1`);
    const first = porcelain(SHA).replace(`${SHA} 3 3 1`, `${SHA} 2 1 1`);

    const records = parseBlameFilePorcelain(second + first);

    assert.deepEqual(
      records.map(({ lineNumber }) => lineNumber),
      [1, 2],
    );
    assert.equal(records[0]?.blame.authorName, "Patrizio Filloramo");
  });

  test("rejects duplicate final line numbers", () => {
    assert.throws(() => parseBlameFilePorcelain(porcelain(SHA) + porcelain(SHA)), /final line/u);
  });
});
