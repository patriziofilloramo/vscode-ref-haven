import type { WorktreeState } from "../../domain/repositoryNavigation";

export function parseWorktreeStatus(output: string): WorktreeState {
  let changedPaths = 0;
  let conflicted = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0 || record.startsWith("# ")) continue;
    if (record.startsWith("? ")) {
      changedPaths += 1;
      untracked += 1;
      continue;
    }
    if (record.startsWith("u ")) {
      changedPaths += 1;
      conflicted += 1;
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      changedPaths += 1;
      const state = record.slice(2, 4);
      if (state.length !== 2) throw new Error("Git returned invalid worktree status.");
      if (!state.startsWith(".")) staged += 1;
      if (!state.endsWith(".")) unstaged += 1;
      if (record.startsWith("2 ")) {
        const originalPath = records[index + 1];
        if (!originalPath) throw new Error("Git returned truncated rename status.");
        index += 1;
      }
      continue;
    }
    if (!record.startsWith("! ")) throw new Error("Git returned unknown worktree status.");
  }
  return { changedPaths, conflicted, staged, unstaged, untracked };
}
