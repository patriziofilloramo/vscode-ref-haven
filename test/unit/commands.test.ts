import assert from "node:assert/strict";

import { COMMAND_IDS } from "../../src/ui/commands/commandIds";

suite("command identifiers", () => {
  test("exposes the complete Milestone 1 command set", () => {
    assert.deepEqual(COMMAND_IDS, {
      compareCurrentBranch: "branchCompare.compareCurrentBranch",
      newComparison: "branchCompare.newComparison",
      refreshAll: "branchCompare.refreshAll",
    });
  });
});
