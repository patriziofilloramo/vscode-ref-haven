import assert from "node:assert/strict";

import { heatmapBucket } from "../../src/domain/fileAnnotations";
import { parseChangedLineRanges } from "../../src/infrastructure/git/diffHunks";

suite("file annotations", () => {
  test("maps blame age into stable heatmap buckets", () => {
    const now = Date.UTC(2026, 6, 15);
    const day = 86_400_000;
    assert.equal(heatmapBucket(now, now), "day");
    assert.equal(heatmapBucket(now - 2 * day, now), "week");
    assert.equal(heatmapBucket(now - 20 * day, now), "month");
    assert.equal(heatmapBucket(now - 200 * day, now), "year");
    assert.equal(heatmapBucket(now - 500 * day, now), "old");
  });

  test("parses additions, changes, and deletion-only zero-context hunks", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "@@ -1 +1,2 @@",
      "@@ -7,3 +8 @@ function",
      "@@ -12,2 +11,0 @@",
    ].join("\n");
    assert.deepEqual(parseChangedLineRanges(diff), [
      { lineCount: 2, startLine: 1 },
      { lineCount: 1, startLine: 8 },
      { lineCount: 0, startLine: 11 },
    ]);
  });
});
