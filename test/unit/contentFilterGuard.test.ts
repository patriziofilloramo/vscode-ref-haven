import assert from "node:assert/strict";

import {
  assertInactiveContentFilterOutput,
  UnsupportedContentFilterError,
} from "../../src/infrastructure/git/contentFilterAttributes";

suite("content filter guard", () => {
  test("accepts complete unspecified and explicitly unset attributes", () => {
    assert.doesNotThrow(() =>
      assertInactiveContentFilterOutput(
        "plain.txt\0filter\0unspecified\0other.txt\0filter\0unset\0",
        ["plain.txt", "other.txt"],
      ),
    );
  });

  test("rejects active, malformed, duplicate, missing, and unexpected attributes", () => {
    for (const output of [
      "filtered.bin\0filter\0lfs\0",
      "filtered.bin\0filter\0set\0",
      "filtered.bin\0filter\0",
      "other.bin\0filter\0unspecified\0",
      "filtered.bin\0diff\0unspecified\0",
      "filtered.bin\0filter\0unspecified\0filtered.bin\0filter\0unspecified\0",
    ]) {
      assert.throws(
        () => assertInactiveContentFilterOutput(output, ["filtered.bin"]),
        UnsupportedContentFilterError,
      );
    }
  });
});
