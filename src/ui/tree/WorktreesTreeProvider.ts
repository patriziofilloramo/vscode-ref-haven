import { basename } from "node:path";

import * as vscode from "vscode";

import type { RepositoryIdentity } from "../../domain/comparison";
import { pathIdentityKey } from "../../domain/pathValidation";
import type { WorktreeInfo } from "../../domain/worktree";
import { shortSha } from "../../domain/comparisonResult";
import type { WorktreeState } from "../../domain/repositoryNavigation";
import { pluralize } from "../format";

export interface WorktreeRepositoryNode {
  readonly kind: "worktreeRepository";
  readonly repository: RepositoryIdentity;
}

export interface WorktreeNode {
  readonly current: boolean;
  readonly kind: "worktree";
  readonly repository: RepositoryIdentity;
  readonly state: WorktreeState | undefined;
  readonly worktree: WorktreeInfo;
}

export interface WorktreeMessageNode {
  readonly icon?: "error" | "info";
  readonly kind: "worktreeMessage";
  readonly label: string;
  readonly tooltip?: string;
}

export type WorktreesTreeNode = WorktreeMessageNode | WorktreeNode | WorktreeRepositoryNode;
export interface WorktreeSnapshot {
  readonly state: WorktreeState | undefined;
  readonly worktree: WorktreeInfo;
}

type WorktreeLoader = (repositoryRoot: string, signal: AbortSignal) => Promise<WorktreeSnapshot[]>;

export class WorktreesTreeProvider
  implements vscode.TreeDataProvider<WorktreesTreeNode>, vscode.Disposable
{
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cache = new Map<string, Promise<WorktreeSnapshot[]>>();
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
      item.iconPath = new vscode.ThemeIcon(element.icon ?? "info");
      item.tooltip = element.tooltip;
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
      worktreeStateDescription(element.state),
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
      const snapshots = await pending;
      if (snapshots.length === 0) {
        return [{ kind: "worktreeMessage", label: "No worktrees in this repository." }];
      }
      return snapshots.map(({ state, worktree }) => ({
        current: pathIdentityKey(worktree.path) === pathIdentityKey(repository.rootPath),
        kind: "worktree",
        repository,
        state,
        worktree,
      }));
    } catch (error) {
      if (this.cache.get(key) === pending) this.cache.delete(key);
      return [
        {
          icon: "error",
          kind: "worktreeMessage",
          label: "Could not list worktrees. Use Refresh to try again.",
          ...(error instanceof Error ? { tooltip: error.message } : {}),
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
    worktreeStateDescription(element.state),
  ].join(" · ");
}

function worktreeStateDescription(state: WorktreeState | undefined): string {
  if (!state) return "state unavailable";
  if (state.changedPaths === 0) return "clean";
  return [
    pluralize(state.changedPaths, "changed path"),
    ...(state.staged > 0 ? [`${state.staged.toString()} staged`] : []),
    ...(state.unstaged > 0 ? [`${state.unstaged.toString()} unstaged`] : []),
    ...(state.untracked > 0 ? [`${state.untracked.toString()} untracked`] : []),
    ...(state.conflicted > 0 ? [`${state.conflicted.toString()} conflicted`] : []),
  ].join(", ");
}
