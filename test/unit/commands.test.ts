import assert from "node:assert/strict";

import { COMMAND_IDS } from "../../src/ui/commands/commandIds";

suite("command identifiers", () => {
  test("exposes the complete command set", () => {
    assert.deepEqual(COMMAND_IDS, {
      applyStash: "branchCompare.applyStash",
      closeComparison: "branchCompare.closeComparison",
      compareCurrentBranch: "branchCompare.compareCurrentBranch",
      copyCommitMessage: "branchCompare.copyCommitMessage",
      copyCommitSha: "branchCompare.copyCommitSha",
      copyComparisonSummary: "branchCompare.copyComparisonSummary",
      copyFilePath: "branchCompare.copyFilePath",
      copyRelativeFilePath: "branchCompare.copyRelativeFilePath",
      copyStashMessage: "branchCompare.copyStashMessage",
      dropStash: "branchCompare.dropStash",
      newComparison: "branchCompare.newComparison",
      openFile: "branchCompare.openFile",
      openFileAtRevision: "branchCompare.openFileAtRevision",
      openFileDiff: "branchCompare.openFileDiff",
      pinComparison: "branchCompare.pinComparison",
      popStash: "branchCompare.popStash",
      refreshAll: "branchCompare.refreshAll",
      refreshComparison: "branchCompare.refreshComparison",
      refreshStashes: "branchCompare.refreshStashes",
      showLineBlameActions: "branchCompare.showLineBlameActions",
      stashAllChanges: "branchCompare.stashAllChanges",
      swapComparison: "branchCompare.swapComparison",
      toggleInlineBlame: "branchCompare.toggleInlineBlame",
      unpinComparison: "branchCompare.unpinComparison",
      viewFilesAsList: "branchCompare.viewFilesAsList",
      viewFilesAsTree: "branchCompare.viewFilesAsTree",
    });
  });
});
