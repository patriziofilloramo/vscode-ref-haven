import assert from "node:assert/strict";

import { COMMAND_IDS } from "../../src/ui/commands/commandIds";

suite("command identifiers", () => {
  test("exposes the complete command set", () => {
    assert.deepEqual(COMMAND_IDS, {
      changeComparisonMode: "refhaven.changeComparisonMode",
      closeComparison: "refhaven.closeComparison",
      compareCurrentBranch: "refhaven.compareCurrentBranch",
      copyCommitMessage: "refhaven.copyCommitMessage",
      copyCommitSha: "refhaven.copyCommitSha",
      copyComparisonSummary: "refhaven.copyComparisonSummary",
      copyFilePath: "refhaven.copyFilePath",
      copyRelativeFilePath: "refhaven.copyRelativeFilePath",
      copyStashMessage: "refhaven.copyStashMessage",
      newComparison: "refhaven.newComparison",
      openFile: "refhaven.openFile",
      openFileAtRevision: "refhaven.openFileAtRevision",
      openFileDiff: "refhaven.openFileDiff",
      pinComparison: "refhaven.pinComparison",
      refreshAll: "refhaven.refreshAll",
      refreshComparison: "refhaven.refreshComparison",
      refreshStashes: "refhaven.refreshStashes",
      showLineBlameActions: "refhaven.showLineBlameActions",
      swapComparison: "refhaven.swapComparison",
      toggleInlineBlame: "refhaven.toggleInlineBlame",
      unpinComparison: "refhaven.unpinComparison",
      viewFilesAsList: "refhaven.viewFilesAsList",
      viewFilesAsTree: "refhaven.viewFilesAsTree",
    });
  });
});
