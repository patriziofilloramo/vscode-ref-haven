import * as vscode from "vscode";

import type { BranchRef, RepositoryIdentity } from "../../domain/comparison";
import { pathIdentityKey } from "../../domain/pathValidation";

export const BRANCHES_VIEW_ID = "refhaven.branches";

export interface BranchRepositoryNode {
  readonly kind: "branchRepository";
  readonly repository: RepositoryIdentity;
}

export interface BranchNode {
  readonly branch: BranchRef;
  readonly current: boolean;
  readonly kind: "branch";
  readonly repository: RepositoryIdentity;
}

export interface BranchMessageNode {
  readonly kind: "branchMessage";
  readonly label: string;
}

export type BranchesTreeNode = BranchMessageNode | BranchNode | BranchRepositoryNode;

export interface BranchSnapshot {
  readonly branches: readonly BranchRef[];
  readonly currentBranchName: string | null;
}

type BranchLoader = (repositoryRoot: string, signal: AbortSignal) => Promise<BranchSnapshot>;

export class BranchesTreeProvider
  implements vscode.TreeDataProvider<BranchesTreeNode>, vscode.Disposable
{
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cache = new Map<string, Promise<BranchSnapshot>>();
  private disposed = false;
  private loader: BranchLoader | undefined;
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    BranchesTreeNode | undefined
  >();
  private repositories: readonly RepositoryIdentity[] = [];

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setLoader(loader: BranchLoader): void {
    this.loader = loader;
  }

  public setRepositories(repositories: readonly RepositoryIdentity[]): void {
    if (this.disposed) return;
    this.repositories = repositories;
    this.refresh();
  }

  public refresh(): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
    this.cache.clear();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refresh();
    this.repositories = [];
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getTreeItem(element: BranchesTreeNode): vscode.TreeItem {
    if (element.kind === "branchMessage") {
      const item = new vscode.TreeItem(element.label);
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    if (element.kind === "branchRepository") return repositoryItem(element.repository, "branches");
    const item = new vscode.TreeItem(element.branch.displayName);
    item.contextValue = element.current ? "refhaven.branchCurrent" : "refhaven.branch";
    if (element.current) item.description = "current";
    else if (element.branch.kind === "remoteBranch") item.description = "remote";
    item.iconPath = new vscode.ThemeIcon(
      element.current ? "check" : element.branch.kind === "remoteBranch" ? "cloud" : "git-branch",
    );
    item.id = `${element.repository.rootPath}:branch:${element.branch.fullName}`;
    item.tooltip = `${element.branch.fullName}\n${element.repository.rootPath}`;
    return item;
  }

  public async getChildren(element?: BranchesTreeNode): Promise<BranchesTreeNode[]> {
    if (this.disposed) return [];
    if (!element) {
      if (this.repositories.length === 1) {
        const repository = this.repositories[0];
        return repository ? this.loadBranches(repository) : [];
      }
      return this.repositories.map((repository) => ({ kind: "branchRepository", repository }));
    }
    return element.kind === "branchRepository" ? this.loadBranches(element.repository) : [];
  }

  private async loadBranches(repository: RepositoryIdentity): Promise<BranchesTreeNode[]> {
    if (!this.loader) return [];
    const key = pathIdentityKey(repository.rootPath);
    let pending = this.cache.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = this.loader(repository.rootPath, controller.signal);
      this.cache.set(key, pending);
      this.abortControllers.set(key, controller);
    }
    try {
      const snapshot = await pending;
      if (snapshot.branches.length === 0) {
        return [{ kind: "branchMessage", label: "No branches in this repository." }];
      }
      return snapshot.branches.map((branch) => ({
        branch,
        current: branch.kind === "localBranch" && branch.displayName === snapshot.currentBranchName,
        kind: "branch",
        repository,
      }));
    } catch (error) {
      if (this.cache.get(key) === pending) this.cache.delete(key);
      return [
        {
          kind: "branchMessage",
          label: error instanceof Error ? error.message : "Could not list branches.",
        },
      ];
    } finally {
      if (this.cache.get(key) === pending) this.abortControllers.delete(key);
    }
  }
}

function repositoryItem(repository: RepositoryIdentity, suffix: string): vscode.TreeItem {
  const item = new vscode.TreeItem(repository.label, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = new vscode.ThemeIcon("repo");
  item.id = `${suffix}:${repository.rootPath}`;
  item.tooltip = repository.rootPath;
  return item;
}
