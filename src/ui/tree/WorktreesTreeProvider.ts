import { basename } from "node:path";

import * as vscode from "vscode";

import type { RepositoryIdentity } from "../../domain/comparison";
import { pathIdentityKey } from "../../domain/pathValidation";
import type { WorktreeInfo } from "../../domain/worktree";
import { shortSha } from "../../domain/comparisonResult";

export const WORKTREES_VIEW_ID = "refhaven.worktrees";

export interface WorktreeRepositoryNode {
  readonly kind: "worktreeRepository";
  readonly repository: RepositoryIdentity;
}

export interface WorktreeNode {
  readonly current: boolean;
  readonly kind: "worktree";
  readonly repository: RepositoryIdentity;
  readonly worktree: WorktreeInfo;
}

export interface WorktreeMessageNode {
  readonly kind: "worktreeMessage";
  readonly label: string;
}

export type WorktreesTreeNode = WorktreeMessageNode | WorktreeNode | WorktreeRepositoryNode;
type WorktreeLoader = (repositoryRoot: string, signal: AbortSignal) => Promise<WorktreeInfo[]>;

export class WorktreesTreeProvider
  implements vscode.TreeDataProvider<WorktreesTreeNode>, vscode.Disposable
{
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cache = new Map<string, Promise<WorktreeInfo[]>>();
  private disposed = false;
  private loader: WorktreeLoader | undefined;
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    WorktreesTreeNode | undefined
  >();
  private repositories: readonly RepositoryIdentity[] = [];

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setLoader(loader: WorktreeLoader): void {
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

  public getTreeItem(element: WorktreesTreeNode): vscode.TreeItem {
    if (element.kind === "worktreeMessage") {
      const item = new vscode.TreeItem(element.label);
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    if (element.kind === "worktreeRepository") {
      const item = new vscode.TreeItem(
        element.repository.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon("repo");
      item.id = `worktrees:${element.repository.rootPath}`;
      item.tooltip = element.repository.rootPath;
      return item;
    }

    const { worktree } = element;
    const item = new vscode.TreeItem(basename(worktree.path) || worktree.path);
    item.contextValue = "refhaven.worktree";
    item.description = worktreeDescription(element);
    item.iconPath = new vscode.ThemeIcon(worktree.locked ? "lock" : "repo");
    item.id = `${element.repository.rootPath}:worktree:${worktree.path}`;
    item.tooltip = [
      worktree.path,
      worktree.branchFullName ?? `detached at ${shortSha(worktree.headSha)}`,
      ...(worktree.locked
        ? [`locked${worktree.lockedReason ? `: ${worktree.lockedReason}` : ""}`]
        : []),
      ...(worktree.prunableReason ? [`prunable: ${worktree.prunableReason}`] : []),
    ].join("\n");
    item.command = {
      arguments: [element],
      command: "refhaven.openWorktree",
      title: "Open Worktree in New Window",
    };
    return item;
  }

  public async getChildren(element?: WorktreesTreeNode): Promise<WorktreesTreeNode[]> {
    if (this.disposed) return [];
    if (!element) {
      if (this.repositories.length === 1) {
        const repository = this.repositories[0];
        return repository ? this.loadWorktrees(repository) : [];
      }
      return this.repositories.map((repository) => ({ kind: "worktreeRepository", repository }));
    }
    return element.kind === "worktreeRepository" ? this.loadWorktrees(element.repository) : [];
  }

  private async loadWorktrees(repository: RepositoryIdentity): Promise<WorktreesTreeNode[]> {
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
      const worktrees = await pending;
      if (worktrees.length === 0) {
        return [{ kind: "worktreeMessage", label: "No worktrees in this repository." }];
      }
      return worktrees.map((worktree) => ({
        current: pathIdentityKey(worktree.path) === pathIdentityKey(repository.rootPath),
        kind: "worktree",
        repository,
        worktree,
      }));
    } catch (error) {
      if (this.cache.get(key) === pending) this.cache.delete(key);
      return [
        {
          kind: "worktreeMessage",
          label: error instanceof Error ? error.message : "Could not list worktrees.",
        },
      ];
    } finally {
      if (this.cache.get(key) === pending) this.abortControllers.delete(key);
    }
  }
}

function worktreeDescription(element: WorktreeNode): string {
  const branch = element.worktree.branchFullName?.replace(/^refs\/heads\//u, "") ?? "detached";
  return [
    branch,
    ...(element.current ? ["current"] : []),
    ...(element.worktree.locked ? ["locked"] : []),
  ].join(" · ");
}
