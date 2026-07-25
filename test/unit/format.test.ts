import assert from "node:assert/strict";

import {
  formatDiffStats,
  formatExactTime,
  formatRelativeTime,
  pluralize,
} from "../../src/ui/format";

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

suite("formatExactTime", () => {
  // Local time, so the assertions compare against the same construction
  // rather than a hard-coded string that would differ per machine.
  const at = (year: number, month: number, day: number, hour: number, minute: number): number =>
    new Date(year, month - 1, day, hour, minute).getTime();
  const clock = (epochMs: number): string =>
    new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  test("shows only the clock for a commit made today", () => {
    const now = at(2026, 7, 22, 18, 5);
    const earlier = at(2026, 7, 22, 9, 30);
    assert.equal(formatExactTime(earlier, now), clock(earlier));
  });

  test("adds the date once the commit is not from today, and the year once it is not from this year", () => {
    const now = at(2026, 7, 22, 18, 5);

    // Yesterday: same year, so the year is left out.
    const yesterday = at(2026, 7, 21, 23, 55);
    assert.equal(
      formatExactTime(yesterday, now),
      `${new Date(yesterday).toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock(yesterday)}`,
    );
    assert.doesNotMatch(formatExactTime(yesterday, now), /2026/u);

    // Last year: the year becomes load-bearing.
    assert.match(formatExactTime(at(2025, 12, 31, 10, 0), now), /2025/u);
  });

  test("treats a commit from an hour ago that crossed midnight as a different day", () => {
    // 00:30 "today" and 23:30 "yesterday" are an hour apart but must not both
    // render as a bare clock, or they would be indistinguishable.
    const now = at(2026, 7, 22, 0, 30);
    const beforeMidnight = at(2026, 7, 21, 23, 30);
    assert.match(formatExactTime(beforeMidnight, now), /,/u);
    assert.equal(formatExactTime(now, now), clock(now));
  });
});
