import assert from "node:assert/strict";

import { COMMAND_IDS } from "../../src/ui/commands/commandIds";

suite("command identifiers", () => {
  test("exposes the complete command set", () => {
    assert.deepEqual(COMMAND_IDS, {
      changeComparisonMode: "refhaven.changeComparisonMode",
      closeComparison: "refhaven.closeComparison",
      compareBranchWithCurrent: "refhaven.compareBranchWithCurrent",
      compareCurrentBranch: "refhaven.compareCurrentBranch",
      copyBranchName: "refhaven.copyBranchName",
      copyCommitMessage: "refhaven.copyCommitMessage",
      copyCommitSha: "refhaven.copyCommitSha",
      copyComparisonSummary: "refhaven.copyComparisonSummary",
      copyFilePath: "refhaven.copyFilePath",
      copyRelativeFilePath: "refhaven.copyRelativeFilePath",
      copyStashMessage: "refhaven.copyStashMessage",
      copyWorktreePath: "refhaven.copyWorktreePath",
      newComparison: "refhaven.newComparison",
      openFile: "refhaven.openFile",
      openFileAtRevision: "refhaven.openFileAtRevision",
      openFileHistoryAtRevision: "refhaven.openFileHistoryAtRevision",
      openFileHistoryDiff: "refhaven.openFileHistoryDiff",
      openWorktree: "refhaven.openWorktree",
      openFileDiff: "refhaven.openFileDiff",
      pinComparison: "refhaven.pinComparison",
      refreshAll: "refhaven.refreshAll",
      refreshComparison: "refhaven.refreshComparison",
      refreshFileHistory: "refhaven.refreshFileHistory",
      refreshRepositoryNavigation: "refhaven.refreshRepositoryNavigation",
      refreshStashes: "refhaven.refreshStashes",
      searchCommits: "refhaven.searchCommits",
      showCommitDetails: "refhaven.showCommitDetails",
      showLineBlameActions: "refhaven.showLineBlameActions",
      showLineHistory: "refhaven.showLineHistory",
      swapComparison: "refhaven.swapComparison",
      toggleInlineBlame: "refhaven.toggleInlineBlame",
      unpinComparison: "refhaven.unpinComparison",
      viewFilesAsList: "refhaven.viewFilesAsList",
      viewFilesAsTree: "refhaven.viewFilesAsTree",
    });
  });
});
