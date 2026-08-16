import assert from "node:assert/strict";

import {
  DEFAULT_HEATMAP_LOCATIONS,
  heatmapBucket,
  heatmapFileModeOverride,
  normalizeFileBlameFormat,
  normalizeHeatmapLocations,
  normalizeHeatmapToggleMode,
  toggledHeatmapMode,
} from "../../src/domain/fileAnnotations";
import { parseChangedLineRanges } from "../../src/infrastructure/git/diffHunks";

suite("file annotations", () => {
  test("maps blame age into stable heatmap buckets", () => {
    const now = Date.UTC(2026, 6, 15);
    const day = 86_400_000;
    assert.equal(heatmapBucket(now, now), "day");
    assert.equal(heatmapBucket(now - day, now), "day");
    assert.equal(heatmapBucket(now - day - 1, now), "week");
    assert.equal(heatmapBucket(now - 2 * day, now), "week");
    assert.equal(heatmapBucket(now - 7 * day, now), "week");
    assert.equal(heatmapBucket(now - 7 * day - 1, now), "month");
    assert.equal(heatmapBucket(now - 20 * day, now), "month");
    assert.equal(heatmapBucket(now - 30 * day, now), "month");
    assert.equal(heatmapBucket(now - 30 * day - 1, now), "year");
    assert.equal(heatmapBucket(now - 200 * day, now), "year");
    assert.equal(heatmapBucket(now - 365 * day, now), "year");
    assert.equal(heatmapBucket(now - 365 * day - 1, now), "old");
    assert.equal(heatmapBucket(now - 500 * day, now), "old");
    assert.equal(heatmapBucket(now + day, now), "day");
    assert.equal(heatmapBucket(null, now), "uncommitted");
  });

  test("normalizes heatmap locations in stable visual order", () => {
    assert.deepEqual(normalizeHeatmapLocations(["line", "edge", "line"]), ["edge", "line"]);
    assert.deepEqual(normalizeHeatmapLocations(["unknown", "overview"]), ["overview"]);
    assert.deepEqual(normalizeHeatmapLocations([]), DEFAULT_HEATMAP_LOCATIONS);
    assert.deepEqual(normalizeHeatmapLocations("line"), DEFAULT_HEATMAP_LOCATIONS);
  });

  test("normalizes annotation display settings to safe defaults", () => {
    assert.equal(normalizeFileBlameFormat("compact"), "compact");
    assert.equal(normalizeFileBlameFormat("unknown"), "detailed");
    assert.equal(normalizeHeatmapToggleMode("window"), "window");
    assert.equal(normalizeHeatmapToggleMode("unknown"), "file");
  });

  test("toggles against the displayed mode while treating changes as heatmap off", () => {
    assert.equal(toggledHeatmapMode("off", "off"), "heatmap");
    assert.equal(toggledHeatmapMode("blame", "blame"), "heatmap");
    assert.equal(toggledHeatmapMode("heatmap", "heatmap"), "off");
    assert.equal(toggledHeatmapMode("changes", "heatmap"), "heatmap");
    assert.equal(toggledHeatmapMode("heatmap", "off"), "heatmap");
  });

  test("uses the smallest file override and restores the underlying annotation mode", () => {
    assert.equal(heatmapFileModeOverride("off", true), "heatmap");
    assert.equal(heatmapFileModeOverride("blame", true), "heatmap");
    assert.equal(heatmapFileModeOverride("changes", true), "heatmap");
    assert.equal(heatmapFileModeOverride("heatmap", true), null);
    assert.equal(heatmapFileModeOverride("heatmap", false), "off");
    assert.equal(heatmapFileModeOverride("blame", false), null);
    assert.equal(heatmapFileModeOverride("changes", false), null);
    assert.equal(heatmapFileModeOverride("off", false), null);
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
