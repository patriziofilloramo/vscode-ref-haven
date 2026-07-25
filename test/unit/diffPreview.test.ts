import assert from "node:assert/strict";

import { selectDiffPreviewSection, windowAroundTarget } from "../../src/ui/blame/diffPreview";

/** Two separate changed sections, as `git show --unified=2` emits them. */
const TWO_SECTION_PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index abc1234..def5678 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,4 +10,5 @@ export function head() {",
  " context ten",
  "-removed eleven",
  "+added eleven",
  "+added twelve",
  " context thirteen",
  "@@ -80,3 +81,3 @@ export function tail() {",
  " context eighty-one",
  "-removed eighty-two",
  "+added eighty-two",
].join("\n");

suite("hover diff preview", () => {
  test("drops file plumbing and keeps only diff body lines", () => {
    const section = selectDiffPreviewSection(TWO_SECTION_PATCH, 11);

    assert.ok(section);
    for (const line of section.bodyLines) {
      assert.doesNotMatch(line, /^(?:diff --git|index |--- |\+\+\+ |@@)/u);
    }
    assert.deepEqual(section.bodyLines, [
      " context ten",
      "-removed eleven",
      "+added eleven",
      "+added twelve",
      " context thirteen",
    ]);
  });

  test("selects the section containing the hovered line, not the first one", () => {
    const section = selectDiffPreviewSection(TWO_SECTION_PATCH, 82);

    assert.ok(section);
    assert.equal(section.containsTarget, true);
    assert.equal(section.newStartLine, 81);
    assert.equal(section.totalSections, 2);
    assert.ok(section.bodyLines.includes("+added eighty-two"));
    assert.ok(!section.bodyLines.includes("+added eleven"));
  });

  test("locates the hovered line inside the section, skipping deletions", () => {
    // New-file lines are 10, 11, 12, 13; the deletion does not consume one.
    const section = selectDiffPreviewSection(TWO_SECTION_PATCH, 12);

    assert.ok(section);
    assert.equal(section.bodyLines[section.targetIndex ?? -1], "+added twelve");
  });

  test("falls back to the first section when the line is outside every hunk", () => {
    const section = selectDiffPreviewSection(TWO_SECTION_PATCH, 500);

    assert.ok(section);
    assert.equal(section.containsTarget, false);
    assert.equal(section.newStartLine, 10);
  });

  test("returns nothing when the patch carries no textual change", () => {
    const headersOnly = [
      "diff --git a/logo.png b/logo.png",
      "index abc1234..def5678 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");

    assert.equal(selectDiffPreviewSection(headersOnly, 1), null);
    assert.equal(selectDiffPreviewSection("", 1), null);
  });

  test("keeps the hovered line visible when trimming a long section", () => {
    const body = Array.from({ length: 40 }, (_unused, index) => ` line ${index.toString()}`);

    const around = windowAroundTarget(body, 10, 30);
    assert.equal(around.lines.length, 10);
    assert.ok(around.lines.includes(" line 30"));
    assert.equal(around.trimmedStart, true);

    const fromStart = windowAroundTarget(body, 10, 0);
    assert.equal(fromStart.trimmedStart, false);
    assert.equal(fromStart.trimmedEnd, true);
    assert.equal(fromStart.lines[0], " line 0");

    const untrimmed = windowAroundTarget(body.slice(0, 5), 10, 2);
    assert.deepEqual(untrimmed.lines, body.slice(0, 5));
    assert.equal(untrimmed.trimmedStart, false);
    assert.equal(untrimmed.trimmedEnd, false);
  });
});
