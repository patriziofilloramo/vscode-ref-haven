import type { WorktreeInfo } from "../../domain/worktree";
import { isGitObjectId } from "../../domain/gitObjectId";

export function parseWorktreeList(output: string): WorktreeInfo[] {
  if (output.length === 0) return [];
  const fields = output.split("\0");
  const worktrees: WorktreeInfo[] = [];
  let record: string[] = [];

  for (const field of fields) {
    if (field.length > 0) {
      record.push(field);
      continue;
    }
    if (record.length > 0) {
      worktrees.push(parseRecord(record));
      record = [];
    }
  }
  if (record.length > 0) throw new Error("Git returned an unterminated worktree record.");
  return worktrees;
}

function parseRecord(fields: readonly string[]): WorktreeInfo {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const field of fields) {
    const separator = field.indexOf(" ");
    if (separator === -1) {
      flags.add(field);
      continue;
    }
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (values.has(key)) throw new Error("Git returned duplicate worktree metadata.");
    values.set(key, value);
  }

  const path = values.get("worktree");
  const headSha = values.get("HEAD");
  if (!path || !headSha || !isGitObjectId(headSha)) {
    throw new Error("Git returned invalid worktree metadata.");
  }
  const branchFullName = values.get("branch");
  if (branchFullName && !branchFullName.startsWith("refs/heads/")) {
    throw new Error("Git returned an invalid worktree branch.");
  }
  const lockedReason = values.get("locked");
  const prunableReason = values.get("prunable");

  return {
    bare: flags.has("bare"),
    detached: flags.has("detached"),
    headSha,
    locked: flags.has("locked") || values.has("locked"),
    path,
    ...(branchFullName ? { branchFullName } : {}),
    ...(lockedReason ? { lockedReason } : {}),
    ...(prunableReason ? { prunableReason } : {}),
  };
}
