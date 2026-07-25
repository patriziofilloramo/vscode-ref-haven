import * as vscode from "vscode";

import type { BranchRef, RepositoryIdentity } from "../../domain/comparison";

interface BranchQuickPickItem extends vscode.QuickPickItem {
  readonly branch?: BranchRef;
}

export async function pickRepository(
  repositories: readonly RepositoryIdentity[],
): Promise<RepositoryIdentity | null> {
  if (repositories.length === 1) return repositories[0] ?? null;

  const selected = await vscode.window.showQuickPick(
    repositories.map((repository) => ({
      description: repository.rootPath,
      iconPath: new vscode.ThemeIcon("repo"),
      label: repository.label,
      repository,
    })),
    {
      matchOnDescription: true,
      placeHolder: "Select a repository",
      title: "RefHaven: New Comparison",
    },
  );
  return selected?.repository ?? null;
}

export async function pickBranch(
  branches: readonly BranchRef[],
  placeHolder: string,
  currentBranchName?: string | null,
): Promise<BranchRef | null> {
  const local = sortBranches(
    branches.filter((branch) => branch.kind === "localBranch"),
    currentBranchName,
  );
  const remote = sortBranches(
    branches.filter((branch) => branch.kind === "remoteBranch"),
    null,
  );

  const items: BranchQuickPickItem[] = [];
  if (local.length > 0) {
    items.push({ kind: vscode.QuickPickItemKind.Separator, label: "local branches" });
    items.push(...local.map((branch) => toBranchItem(branch, currentBranchName)));
  }
  if (remote.length > 0) {
    items.push({ kind: vscode.QuickPickItemKind.Separator, label: "remote branches" });
    items.push(...remote.map((branch) => toBranchItem(branch, null)));
  }

  const selected = await vscode.window.showQuickPick(items, {
    matchOnDescription: true,
    placeHolder,
    title: "RefHaven: New Comparison",
  });
  return selected?.branch ?? null;
}

function toBranchItem(
  branch: BranchRef,
  currentBranchName: string | null | undefined,
): BranchQuickPickItem {
  const isCurrent = branch.displayName === currentBranchName;
  return {
    branch,
    ...(isCurrent ? { description: "current branch" } : {}),
    iconPath: new vscode.ThemeIcon(branch.kind === "localBranch" ? "git-branch" : "cloud"),
    label: branch.displayName,
  };
}

function sortBranches(
  branches: readonly BranchRef[],
  preferredBranch: string | null | undefined,
): BranchRef[] {
  return [...branches].sort((left, right) => {
    if (preferredBranch && left.displayName === preferredBranch) return -1;
    if (preferredBranch && right.displayName === preferredBranch) return 1;
    return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
  });
}
