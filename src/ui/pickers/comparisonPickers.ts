import * as vscode from "vscode";

import type { BranchRef, RepositoryIdentity } from "../../domain/comparison";
import { MAX_INTERACTIVE_INPUT_LENGTH } from "../../domain/inputLimits";
import { resolveRef } from "../../infrastructure/git/GitCli";

interface BranchQuickPickItem extends vscode.QuickPickItem {
  readonly action?: "enterRevision";
  readonly branch?: BranchRef;
}

export async function pickRepository(
  repositories: readonly RepositoryIdentity[],
  title = "RefHaven: New Comparison",
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
      title,
    },
  );
  return selected?.repository ?? null;
}

export async function pickBranch(
  branches: readonly BranchRef[],
  placeHolder: string,
  currentBranchName?: string | null,
  repositoryRoot?: string,
  allowWorkingTree = false,
  title = "RefHaven: New Comparison",
): Promise<BranchRef | null> {
  const local = sortBranches(
    branches.filter((branch) => branch.kind === "localBranch"),
    currentBranchName,
  );
  const remote = sortBranches(
    branches.filter((branch) => branch.kind === "remoteBranch"),
    null,
  );
  const tags = sortBranches(
    branches.filter((branch) => branch.kind === "tag"),
    null,
  );
  const special = branches.filter((branch) => branch.kind === "head");

  const items: BranchQuickPickItem[] = [];
  if (allowWorkingTree) {
    items.push({
      branch: { displayName: "Working Tree", fullName: "WORKTREE", kind: "workingTree" },
      description: "tracked local changes",
      iconPath: new vscode.ThemeIcon("files"),
      label: "Working Tree",
    });
  }
  if (special.length > 0) {
    items.push({ kind: vscode.QuickPickItemKind.Separator, label: "special" });
    items.push(...special.map((branch) => toBranchItem(branch, null)));
  }
  if (local.length > 0) {
    items.push({ kind: vscode.QuickPickItemKind.Separator, label: "local branches" });
    items.push(...local.map((branch) => toBranchItem(branch, currentBranchName)));
  }
  if (remote.length > 0) {
    items.push({ kind: vscode.QuickPickItemKind.Separator, label: "remote branches" });
    items.push(...remote.map((branch) => toBranchItem(branch, null)));
  }
  if (tags.length > 0) {
    items.push({ kind: vscode.QuickPickItemKind.Separator, label: "tags" });
    items.push(...tags.map((branch) => toBranchItem(branch, null)));
  }
  if (repositoryRoot) {
    items.push({ kind: vscode.QuickPickItemKind.Separator, label: "revision" });
    items.push({
      action: "enterRevision",
      description: "SHA or local revision expression",
      iconPath: new vscode.ThemeIcon("edit"),
      label: "Enter a revision...",
    });
  }

  const selected = await vscode.window.showQuickPick(items, {
    matchOnDescription: true,
    placeHolder,
    title,
  });
  if (selected?.action === "enterRevision" && repositoryRoot) {
    const value = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "Commit SHA or local revision, for example HEAD~3",
      prompt: "Enter a revision already available in this repository",
      title: "RefHaven: Enter Revision",
      validateInput: (input) => validateRevisionInput(input),
    });
    if (!value) return null;
    const sha = await resolveRef(repositoryRoot, value);
    return { displayName: value, fullName: sha, kind: "revision" };
  }
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
    iconPath: new vscode.ThemeIcon(
      branch.kind === "localBranch"
        ? "git-branch"
        : branch.kind === "remoteBranch"
          ? "cloud"
          : branch.kind === "tag"
            ? "tag"
            : "git-commit",
    ),
    label: branch.displayName,
  };
}

function validateRevisionInput(value: string): string | undefined {
  if (value.length === 0) return "Enter a revision.";
  if (value.length > MAX_INTERACTIVE_INPUT_LENGTH) return "Revision is too long.";
  if (value.startsWith("-") || value.includes("\0") || /[\r\n]/u.test(value)) {
    return "Revision contains unsupported characters.";
  }
  return undefined;
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
