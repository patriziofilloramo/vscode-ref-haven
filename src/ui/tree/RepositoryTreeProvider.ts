import * as vscode from "vscode";

import type { BranchesTreeNode, BranchesTreeProvider } from "./BranchesTreeProvider";
import type { WorktreesTreeNode, WorktreesTreeProvider } from "./WorktreesTreeProvider";

export const REPOSITORY_VIEW_ID = "refhaven.repository";

interface RepositorySectionNode {
  readonly kind: "repositorySection";
  readonly section: "branches" | "worktrees";
}

export type RepositoryTreeNode = BranchesTreeNode | RepositorySectionNode | WorktreesTreeNode;

const BRANCHES_SECTION: RepositorySectionNode = {
  kind: "repositorySection",
  section: "branches",
};
const WORKTREES_SECTION: RepositorySectionNode = {
  kind: "repositorySection",
  section: "worktrees",
};

/** Presents branches and worktrees as one repository-navigation surface. */
export class RepositoryTreeProvider
  implements vscode.TreeDataProvider<RepositoryTreeNode>, vscode.Disposable
{
  private readonly disposables: vscode.Disposable[];
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    RepositoryTreeNode | undefined
  >();

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly branchesProvider: BranchesTreeProvider,
    private readonly worktreesProvider: WorktreesTreeProvider,
  ) {
    this.disposables = [
      branchesProvider.onDidChangeTreeData(() =>
        this.onDidChangeTreeDataEmitter.fire(BRANCHES_SECTION),
      ),
      worktreesProvider.onDidChangeTreeData(() =>
        this.onDidChangeTreeDataEmitter.fire(WORKTREES_SECTION),
      ),
    ];
  }

  public dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getTreeItem(node: RepositoryTreeNode): vscode.TreeItem {
    if (node.kind === "repositorySection") {
      const item = new vscode.TreeItem(
        node.section === "branches" ? "Branches" : "Worktrees",
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(node.section === "branches" ? "git-branch" : "repo");
      item.id = `repository:${node.section}`;
      return item;
    }
    return isBranchNode(node)
      ? this.branchesProvider.getTreeItem(node)
      : this.worktreesProvider.getTreeItem(node);
  }

  public async getChildren(node?: RepositoryTreeNode): Promise<RepositoryTreeNode[]> {
    if (!node) return [BRANCHES_SECTION, WORKTREES_SECTION];
    if (node.kind === "repositorySection") {
      return node.section === "branches"
        ? this.branchesProvider.getChildren()
        : this.worktreesProvider.getChildren();
    }
    return isBranchNode(node)
      ? this.branchesProvider.getChildren(node)
      : this.worktreesProvider.getChildren(node);
  }

  public getParent(node: RepositoryTreeNode): RepositoryTreeNode | undefined {
    if (node.kind === "repositorySection") return undefined;
    return isBranchNode(node) ? BRANCHES_SECTION : WORKTREES_SECTION;
  }
}

function isBranchNode(node: RepositoryTreeNode): node is BranchesTreeNode {
  return (
    node.kind === "branch" ||
    node.kind === "branchCommit" ||
    node.kind === "branchMessage" ||
    node.kind === "branchRepository"
  );
}
