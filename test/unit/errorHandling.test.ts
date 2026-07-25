import assert from "node:assert/strict";

import { errorIdentifier, errorLogMetadata } from "../../src/application/errorHandling";

suite("error handling", () => {
  test("keeps exception messages out of structured log metadata", () => {
    const error = Object.assign(new Error("private repository data"), { code: "ProcessError" });

    assert.deepEqual(errorLogMetadata(error, "refresh"), {
      errorKind: "ProcessError",
      operation: "refresh",
    });
  });

  test("rejects unsafe identifiers instead of copying arbitrary values", () => {
    const error = Object.assign(new Error("private repository data"), {
      code: "private/path and subject",
    });

    assert.equal(errorIdentifier(error), "Error");
  });
});
