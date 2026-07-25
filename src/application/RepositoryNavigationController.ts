import * as vscode from "vscode";

import type { ComparisonController } from "./ComparisonController";
import type { Logger } from "./Logger";
import {
  discoverRepositories,
  listBranchDetails,
  listRecentCommits,
  listWorktrees,
  readCurrentBranch,
  readWorktreeState,
} from "../infrastructure/git/GitCli";
import type { BranchNode, BranchesTreeProvider } from "../ui/tree/BranchesTreeProvider";
import type { RepositoryTreeNode } from "../ui/tree/RepositoryTreeProvider";
import type { WorktreeNode, WorktreesTreeProvider } from "../ui/tree/WorktreesTreeProvider";
import { pathIdentityKey } from "../domain/pathValidation";
import type { WorktreeInfo } from "../domain/worktree";
import { showTransientSuccess } from "../ui/feedback";

export class RepositoryNavigationController {
  public constructor(
    private readonly branchesProvider: BranchesTreeProvider,
    private readonly repositoryTreeView: vscode.TreeView<RepositoryTreeNode>,
    private readonly worktreesProvider: WorktreesTreeProvider,
    private readonly comparisonController: ComparisonController,
    private readonly logger: Logger,
  ) {}

  public async initialize(): Promise<void> {
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    const repositories = await discoverRepositories();
    this.branchesProvider.setRepositories(repositories);
    this.worktreesProvider.setRepositories(repositories);
    this.logger.info("Refreshed repository navigation", {
      operation: "refreshRepositoryNavigation",
      repositoryCount: repositories.length,
    });
  }

  public async compareBranchWithCurrent(node: BranchNode): Promise<void> {
    await this.comparisonController.compareReferenceWithCurrent(node.repository, node.branch);
  }

  public async compareSelectedBranches(): Promise<void> {
    const branches = this.repositoryTreeView.selection.filter(
      (node): node is BranchNode => node.kind === "branch",
    );
    if (branches.length !== 2) {
      throw new Error("Select exactly two branches under Repository first.");
    }
    const [first, second] = branches;
    if (!first || !second) throw new Error("Select exactly two branches first.");
    if (
      pathIdentityKey(first.repository.rootPath) !== pathIdentityKey(second.repository.rootPath)
    ) {
      throw new Error("Select two branches from the same repository.");
    }
    const selected = await vscode.window.showQuickPick(
      [
        {
          branch: first,
          description: `${second.branch.displayName} becomes the base`,
          label: first.branch.displayName,
        },
        {
          branch: second,
          description: `${first.branch.displayName} becomes the base`,
          label: second.branch.displayName,
        },
      ],
      {
        placeHolder: "The other selected branch will be used as the base",
        title: "RefHaven: Select the Target Branch",
      },
    );
    if (!selected) return;
    const base = selected.branch === first ? second : first;
    await this.comparisonController.compareReferences(
      selected.branch.repository,
      base.branch,
      selected.branch.branch,
    );
  }

  public async copyBranchName(node: BranchNode): Promise<void> {
    await vscode.env.clipboard.writeText(node.branch.displayName);
    showTransientSuccess("Branch name copied");
  }

  public async openWorktree(node: WorktreeNode): Promise<void> {
    const worktree = await this.verifyWorktree(node);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktree.path), {
      forceNewWindow: true,
    });
  }

  public async copyWorktreePath(node: WorktreeNode): Promise<void> {
    const worktree = await this.verifyWorktree(node);
    await vscode.env.clipboard.writeText(worktree.path);
    showTransientSuccess("Worktree path copied");
  }

  public installLoaders(): void {
    this.branchesProvider.setLoaders(
      async (repositoryRoot, signal) => {
        const [branches, currentBranchName] = await Promise.all([
          listBranchDetails(repositoryRoot, signal),
          readCurrentBranch(repositoryRoot, signal),
        ]);
        return { branches, currentBranchName };
      },
      (repositoryRoot, revision, signal) => listRecentCommits(repositoryRoot, revision, 20, signal),
    );
    this.worktreesProvider.setLoader(async (repositoryRoot, signal) => {
      const worktrees = await listWorktrees(repositoryRoot, signal);
      return Promise.all(
        worktrees.map(async (worktree) => ({
          state: await readWorktreeState(worktree.path, signal).catch((error: unknown) => {
            if (signal.aborted) throw error;
            return undefined;
          }),
          worktree,
        })),
      );
    });
  }

  private async verifyWorktree(node: WorktreeNode): Promise<WorktreeInfo> {
    const repositoryKey = pathIdentityKey(node.repository.rootPath);
    const repository = (await discoverRepositories()).find(
      ({ rootPath }) => pathIdentityKey(rootPath) === repositoryKey,
    );
    if (!repository) throw new Error("The selected repository is not part of the workspace.");
    const worktreeKey = pathIdentityKey(node.worktree.path);
    const worktree = (await listWorktrees(repository.rootPath)).find(
      ({ path }) => pathIdentityKey(path) === worktreeKey,
    );
    if (!worktree) throw new Error("The selected worktree is no longer available.");
    return worktree;
  }
}
