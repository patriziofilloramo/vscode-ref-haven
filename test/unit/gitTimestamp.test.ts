import assert from "node:assert/strict";

import { parseGitEpochSeconds } from "../../src/infrastructure/git/gitTimestamp";

suite("Git timestamp validation", () => {
  test("accepts complete decimal timestamps within the JavaScript Date range", () => {
    assert.equal(parseGitEpochSeconds("0"), 0);
    assert.equal(parseGitEpochSeconds("1700000000"), 1_700_000_000);
    assert.equal(parseGitEpochSeconds("8640000000000"), 8_640_000_000_000);
  });

  test("rejects partial, negative, non-string, unsafe, and out-of-range timestamps", () => {
    assert.equal(parseGitEpochSeconds("1700000000trailing"), null);
    assert.equal(parseGitEpochSeconds("-1"), null);
    assert.equal(parseGitEpochSeconds("01"), null);
    assert.equal(parseGitEpochSeconds("8640000000001"), null);
    assert.equal(parseGitEpochSeconds("999999999999999999999"), null);
    assert.equal(parseGitEpochSeconds(1_700_000_000), null);
  });
});
