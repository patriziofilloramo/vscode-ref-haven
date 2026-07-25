import assert from "node:assert/strict";

import type { RichLineHover } from "../../src/domain/blame";
import { richBlameHoverMarkdown } from "../../src/ui/blame/richBlameHover";

const SHA = "a".repeat(40);
const PARENT_SHA = "b".repeat(40);
const NOW = 1_700_000_000_000 + 2 * 60 * 60 * 1000;

function data(overrides: Partial<RichLineHover> = {}): RichLineHover {
  return {
    blame: {
      authorDate: 1_700_000_000_000,
      authorEmail: "patrizio@example.invalid",
      authorName: "Patrizio Filloramo",
      authorTimeZone: "+0100",
      finalLineNumber: 12,
      isCommitted: true,
      originalLineNumber: 8,
      path: "src/old-example.ts",
      previousPath: "src/older-example.ts",
      previousSha: PARENT_SHA,
      sha: SHA,
      summary: "feat: rich hover",
    },
    changedFileCount: 3,
    commitDetails: {
      authorEmail: "patrizio@example.invalid",
      commit: {
        authorDate: 1_700_000_000_000,
        authorName: "Patrizio Filloramo",
        sha: SHA,
        subject: "feat: rich hover",
      },
      committerDate: 1_700_000_000_000,
      committerEmail: "patrizio@example.invalid",
      committerName: "Patrizio Filloramo",
      fullMessage: "feat: rich hover",
      parentShas: [PARENT_SHA],
    },
    fileChange: {
      additions: 4,
      deletions: 2,
      newPath: "src/example.ts",
      oldPath: "src/old-example.ts",
      status: "renamed",
    },
    filePath: "src/example.ts",
    lineNumber: 12,
    parentSha: PARENT_SHA,
    patchPreview: "@@ -1 +1 @@\n-old\n+new",
    repositoryRoot: "C:\\repo",
    userName: null,
    ...overrides,
  };
}

suite("rich blame hover", () => {
  test("renders local metadata, actions, and a bounded diff preview", () => {
    const markdown = richBlameHoverMarkdown(data(), NOW);

    assert.match(markdown, /patrizio@example\\\.invalid/u);
    assert.match(markdown, new RegExp(SHA, "u"));
    assert.match(markdown, /Originally `src\/old\\-example\\\.ts:8`/u);
    assert.match(markdown, /3 changed files/u);
    assert.match(markdown, /\+4 −2 in this file/u);
    assert.match(markdown, /Previous revision diff/u);
    assert.match(markdown, /command:refhaven\.showCommitDetails\?/u);
    assert.match(markdown, /command:refhaven\.openLineDiff\?/u);
    assert.match(markdown, /command:refhaven\.compareFileWithRevision\?/u);
    assert.match(markdown, /command:refhaven\.showFileHistory\?/u);
    assert.match(markdown, /command:refhaven\.showLineHistory\?/u);
    assert.match(markdown, /command:refhaven\.openGitLabFile\?/u);
  });

  test("offers time-travel to the revision before the blamed commit", () => {
    const markdown = richBlameHoverMarkdown(data(), NOW);
    const beforeLink =
      /\[Before This Change\]\(command:refhaven\.openFileAtRevision\?([^)\s]+)\)/u.exec(markdown);
    assert.ok(beforeLink?.[1]);
    assert.deepEqual(JSON.parse(decodeURIComponent(beforeLink[1])), [
      "C:\\repo",
      PARENT_SHA,
      "src/older-example.ts",
    ]);

    const blame = data().blame;
    const withoutPrevious = data({
      blame: {
        authorDate: blame.authorDate,
        authorName: blame.authorName,
        isCommitted: blame.isCommitted,
        path: blame.path,
        sha: blame.sha,
        summary: blame.summary,
      },
    });
    assert.doesNotMatch(richBlameHoverMarkdown(withoutPrevious, NOW), /Before This Change/u);
  });

  test("autolinks GitLab references in the commit summary", () => {
    const markdown = richBlameHoverMarkdown(
      data({ blame: { ...data().blame, summary: "fix login flow (#12, !34)" } }),
      NOW,
    );

    const references = [
      ...markdown.matchAll(/\]\(command:refhaven\.openGitLabReference\?([^)\s]+)\)/gu),
    ];
    assert.equal(references.length, 2);
    assert.deepEqual(JSON.parse(decodeURIComponent(references[0]?.[1] ?? "")), ["C:\\repo", "#12"]);
  });

  test("escapes Git metadata and contains backticks safely inside the diff fence", () => {
    const malicious = data({
      blame: {
        ...data().blame,
        authorName: "[Run](command:refhaven.openFileAtRevision?bad)",
        summary: "``` [Run](command:bad)",
      },
      patchPreview: "```\n[Run](command:bad)\n```",
    });

    const markdown = richBlameHoverMarkdown(malicious, NOW);

    assert.match(markdown, /\\\[Run\\\]\\\(command:refhaven/u);
    assert.match(markdown, /````diff/u);
    assert.doesNotMatch(markdown, /\*\*\[Run\]\(command:/u);
  });

  test("keeps command links intact when metadata contains unbalanced parentheses", () => {
    const markdown = richBlameHoverMarkdown(
      data({
        blame: { ...data().blame, summary: "fix: handle smiley :)" },
        filePath: "src/pages/(auth/login.ts",
      }),
      NOW,
    );

    for (const destination of markdown.matchAll(/\]\(command:([^)\s]*)\)/gu)) {
      const query = destination[1]?.split("?")[1] ?? "";
      assert.doesNotMatch(query, /[()]/u, "command arguments must not contain raw parentheses");
      assert.doesNotThrow(() => JSON.parse(decodeURIComponent(query)));
    }
    const linkCount = [...markdown.matchAll(/\]\(command:/gu)].length;
    assert.equal([...markdown.matchAll(/\]\(command:[^()\s]+\)/gu)].length, linkCount);
  });

  test("hides the original location when the path and line are unchanged", () => {
    const unchanged = data({
      blame: { ...data().blame, originalLineNumber: 12, path: "src/example.ts" },
    });
    assert.doesNotMatch(richBlameHoverMarkdown(unchanged, NOW), /Originally/u);

    const movedLine = data({
      blame: { ...data().blame, originalLineNumber: 8, path: "src/example.ts" },
    });
    assert.match(richBlameHoverMarkdown(movedLine, NOW), /Originally `src\/example\\\.ts:8`/u);
  });

  test("keeps uncommitted hovers concise and action-free", () => {
    const markdown = richBlameHoverMarkdown({
      blame: {
        authorDate: NOW,
        authorName: "Not Committed Yet",
        isCommitted: false,
        path: "src/example.ts",
        sha: "0".repeat(40),
        summary: "",
      },
      filePath: "src/example.ts",
      lineNumber: 1,
      repositoryRoot: "C:\\repo",
      userName: null,
    });

    assert.equal(markdown, "**You** · Uncommitted changes");
  });
});
