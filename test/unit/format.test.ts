import assert from "node:assert/strict";

import { formatDiffStats, formatRelativeTime, pluralize } from "../../src/ui/format";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

suite("formatRelativeTime", () => {
  test("reports moments ago as just now", () => {
    assert.equal(formatRelativeTime(NOW - 30 * 1000, NOW), "just now");
  });

  test("reports minutes, hours, and days", () => {
    assert.equal(formatRelativeTime(NOW - 5 * 60 * 1000, NOW), "5 minutes ago");
    assert.equal(formatRelativeTime(NOW - 3 * 60 * 60 * 1000, NOW), "3 hours ago");
    assert.equal(formatRelativeTime(NOW - 2 * 24 * 60 * 60 * 1000, NOW), "2 days ago");
  });

  test("reports weeks, months, and years", () => {
    assert.equal(formatRelativeTime(NOW - 2 * 7 * 24 * 60 * 60 * 1000, NOW), "2 weeks ago");
    assert.equal(formatRelativeTime(NOW - 65 * 24 * 60 * 60 * 1000, NOW), "2 months ago");
    assert.equal(formatRelativeTime(NOW - 800 * 24 * 60 * 60 * 1000, NOW), "2 years ago");
  });
});

suite("formatDiffStats", () => {
  test("formats grouped additions and deletions", () => {
    assert.equal(formatDiffStats(1405, 23), "+1,405 −23");
  });
});

suite("pluralize", () => {
  test("uses the singular form for exactly one", () => {
    assert.equal(pluralize(1, "file"), "1 file");
  });

  test("uses the plural form otherwise", () => {
    assert.equal(pluralize(0, "commit"), "0 commits");
    assert.equal(pluralize(1405, "file"), "1,405 files");
  });
});
