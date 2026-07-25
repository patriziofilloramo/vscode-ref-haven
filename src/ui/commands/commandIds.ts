export const COMMAND_IDS = {
  compareCurrentBranch: "branchCompare.compareCurrentBranch",
  newComparison: "branchCompare.newComparison",
  refreshAll: "branchCompare.refreshAll",
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];
