import type { BranchRef } from "../../domain/comparison";

export function parseBranchRefs(stdout: string): BranchRef[] {
  const refs = new Map<string, BranchRef>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [fullName, displayName] = line.split("\t");
    if (!fullName || !displayName || fullName.endsWith("/HEAD")) continue;
    if (!fullName.startsWith("refs/heads/") && !fullName.startsWith("refs/remotes/")) continue;

    refs.set(fullName, {
      displayName,
      fullName,
      kind: fullName.startsWith("refs/heads/") ? "localBranch" : "remoteBranch",
    });
  }

  return [...refs.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }),
  );
}
