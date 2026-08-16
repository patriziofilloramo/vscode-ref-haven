import assert from "node:assert/strict";

import type { LineBlame } from "../../src/domain/blame";
import {
  blameHoverMarkdown,
  fileBlameAnnotationText,
  inlineBlameText,
  statusBarBlameText,
} from "../../src/ui/blame/blamePresentation";

const NOW = 1_700_000_000_000 + 2 * 60 * 60 * 1000;

const COMMITTED: LineBlame = {
  authorDate: 1_700_000_000_000,
  authorName: "Patrizio Filloramo",
  isCommitted: true,
  path: "src/example.ts",
  sha: "a".repeat(40),
  summary: "feat: add blame support",
};

const UNCOMMITTED: LineBlame = {
  authorDate: NOW,
  authorName: "Not Committed Yet",
  isCommitted: false,
  path: "src/example.ts",
  sha: "0".repeat(40),
  summary: "",
};

suite("blame presentation", () => {
  test("formats inline blame with author, relative time, and summary", () => {
    assert.equal(
      inlineBlameText(COMMITTED, null, NOW),
      "Patrizio Filloramo, 2 hours ago · feat: add blame support",
    );
  });

  test("formats bounded whole-file annotations in detailed and compact modes", () => {
    assert.equal(
      fileBlameAnnotationText(COMMITTED, "Patrizio Filloramo", NOW, "detailed"),
      "You, 2 hours ago \u00b7 feat: add blame support",
    );
    assert.equal(
      fileBlameAnnotationText(COMMITTED, null, NOW, "compact"),
      "Patrizio Filloramo, 2 hours ago",
    );

    const longBlame: LineBlame = {
      ...COMMITTED,
      authorName: `  ${"A".repeat(50)}\nignored  `,
      summary: `${"B".repeat(100)}\nignored`,
    };
    const text = fileBlameAnnotationText(longBlame, null, NOW, "detailed");
    assert.doesNotMatch(text, /\n/u);
    assert.match(text, /^A{39}\u2026, 2 hours ago \u00b7 B{79}\u2026$/u);
  });

  test("formats uncommitted whole-file annotations without commit metadata", () => {
    assert.equal(
      fileBlameAnnotationText(UNCOMMITTED, null, NOW, "detailed"),
      "You \u00b7 Uncommitted changes",
    );
  });

  test("replaces the configured Git user with You", () => {
    assert.equal(
      inlineBlameText(COMMITTED, "Patrizio Filloramo", NOW),
      "You, 2 hours ago · feat: add blame support",
    );
  });

  test("labels uncommitted lines without commit details", () => {
    assert.equal(inlineBlameText(UNCOMMITTED, null, NOW), "You · Uncommitted changes");
    assert.equal(statusBarBlameText(UNCOMMITTED, null, NOW), "$(git-commit) You · uncommitted");
  });

  test("formats the status bar entry", () => {
    assert.equal(
      statusBarBlameText(COMMITTED, "someone else", NOW),
      "$(git-commit) Patrizio Filloramo · 2 hours ago",
    );
  });

  test("keeps inline and status blame compact and single-line", () => {
    const longBlame: LineBlame = {
      ...COMMITTED,
      authorName: `${"A".repeat(50)}\nignored`,
      summary: `${"B".repeat(100)}\nignored`,
    };
    const inline = inlineBlameText(longBlame, null, NOW);
    const status = statusBarBlameText(longBlame, null, NOW);

    assert.match(inline, /^A{39}…/u);
    assert.match(inline, /B{79}…$/u);
    assert.doesNotMatch(inline, /\n/u);
    assert.equal(status, `$(git-commit) ${"A".repeat(39)}… · 2 hours ago`);
    assert.doesNotMatch(status, /\n/u);
  });

  test("builds hover markdown with command links for committed lines", () => {
    const markdown = blameHoverMarkdown(COMMITTED, null, "C:\\repo", NOW);

    assert.match(markdown, /\*\*Patrizio Filloramo\*\*, 2 hours ago/);
    assert.match(markdown, /feat: add blame support/);
    assert.match(markdown, /`aaaaaaaa`/);
    assert.match(markdown, /command:refhaven\.copyCommitSha\?/);
    assert.match(markdown, /command:refhaven\.copyCommitMessage\?/);
    assert.match(markdown, /command:refhaven\.openFileAtRevision\?/);
    assert.match(markdown, /command:refhaven\.openBrowserFile\?/);

    const revisionLink = /command:refhaven\.openFileAtRevision\?([^)]+)\)/.exec(markdown);
    assert.ok(revisionLink?.[1]);
    assert.deepEqual(JSON.parse(decodeURIComponent(revisionLink[1])), [
      "C:\\repo",
      COMMITTED.sha,
      "src/example.ts",
    ]);
  });

  test("omits actions from uncommitted hovers", () => {
    const markdown = blameHoverMarkdown(UNCOMMITTED, null, "C:\\repo", NOW);

    assert.equal(markdown, "**You** · Uncommitted changes");
  });

  test("keeps command links intact when arguments contain parentheses", () => {
    const parenthesized: LineBlame = { ...COMMITTED, path: "src/(group/file.ts" };
    const markdown = blameHoverMarkdown(parenthesized, null, "C:\\repo (work)", NOW);

    for (const destination of markdown.matchAll(/\]\(command:([^)\s]*)\)/gu)) {
      const query = destination[1]?.split("?")[1] ?? "";
      assert.doesNotMatch(query, /[()]/u, "command arguments must not contain raw parentheses");
      assert.doesNotThrow(() => JSON.parse(decodeURIComponent(query)));
    }
    const linkCount = [...markdown.matchAll(/\]\(command:/gu)].length;
    assert.equal([...markdown.matchAll(/\]\(command:[^()\s]+\)/gu)].length, linkCount);
    assert.equal(linkCount, 4);
  });

  test("escapes Git-controlled Markdown in trusted hovers", () => {
    const malicious: LineBlame = {
      ...COMMITTED,
      authorName: "**spoofed**",
      summary: "[Injected](command:refhaven.openFileAtRevision?payload)",
    };
    const markdown = blameHoverMarkdown(malicious, null, "C:\\repo", NOW);

    assert.doesNotMatch(markdown, /\*\*\*\*spoofed\*\*\*\*/);
    assert.doesNotMatch(markdown, /\[Injected\]\(command:/);
    assert.match(markdown, /\\\[Injected\\\]\\\(command:/);
  });
});
