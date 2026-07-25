import assert from "node:assert/strict";

import { formatLogEntry } from "../../src/infrastructure/logging/OutputChannelLogger";

suite("OutputChannelLogger", () => {
  test("formats structured metadata deterministically", () => {
    const output = formatLogEntry(
      "info",
      "Extension activated",
      { durationMs: 12, operation: "activate" },
      new Date("2026-07-14T10:00:00.000Z"),
    );

    assert.equal(
      output,
      '2026-07-14T10:00:00.000Z INFO Extension activated {"durationMs":12,"operation":"activate"}',
    );
  });

  test("redacts metadata whose keys may contain sensitive values", () => {
    const output = formatLogEntry(
      "error",
      "Command failed",
      { operation: "refresh", remoteUrl: "https://secret@example.test", token: "secret" },
      new Date("2026-07-14T10:00:00.000Z"),
    );

    assert.equal(
      output,
      '2026-07-14T10:00:00.000Z ERROR Command failed {"operation":"refresh","remoteUrl":"[REDACTED]","token":"[REDACTED]"}',
    );
  });
});
