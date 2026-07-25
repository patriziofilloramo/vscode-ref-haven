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
import type { WorktreeNode, WorktreesTreeProvider } from "../ui/tree/WorktreesTreeProvider";
import { pathIdentityKey } from "../domain/pathValidation";
import type { WorktreeInfo } from "../domain/worktree";

export class RepositoryNavigationController {
  public constructor(
    private readonly branchesProvider: BranchesTreeProvider,
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

  public async copyBranchName(node: BranchNode): Promise<void> {
    await vscode.env.clipboard.writeText(node.branch.displayName);
    void vscode.window.showInformationMessage("Branch name copied to the clipboard.");
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
    void vscode.window.showInformationMessage("Worktree path copied to the clipboard.");
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
