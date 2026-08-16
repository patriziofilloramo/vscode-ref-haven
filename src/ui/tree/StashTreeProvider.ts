import * as vscode from "vscode";

import type { RepositoryIdentity } from "../../domain/comparison";
import { shortSha, sumDiffTotals, type FileChange } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import { pathIdentityKey } from "../../domain/pathValidation";
import type { StashEntry } from "../../domain/stash";
import { formatDiffStats, formatRelativeTime, pluralize } from "../format";
import { escapeMarkdown } from "../markdown";
import {
  buildChangeNodes,
  createFileItem,
  createFolderItem,
  createMessageItem,
  getFolderChildren,
  type FileNode,
  type FolderNode,
  type MessageNode,
} from "./changeNodes";

export const STASH_VIEW_ID = "refhaven.stashes";

export interface StashRepositoryNode {
  readonly kind: "repository";
  readonly repository: RepositoryIdentity;
}

export interface StashNode {
  readonly kind: "stash";
  readonly repository: RepositoryIdentity;
  readonly stash: StashEntry;
}

export type StashTreeNode = FileNode | FolderNode | MessageNode | StashNode | StashRepositoryNode;

type StashLoader = (repositoryRoot: string, signal: AbortSignal) => Promise<StashEntry[]>;
type StashFilesLoader = (
  repositoryRoot: string,
  fromSha: string,
  toSha: string,
  signal: AbortSignal,
) => Promise<FileChange[]>;

export class StashTreeProvider
  implements vscode.TreeDataProvider<StashTreeNode>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    StashTreeNode | undefined
  >();
  private repositories: readonly RepositoryIdentity[] = [];
  private disposed = false;
  private filter = "";
  private readonly stashFiles = new Map<string, Promise<FileChange[]>>();
  private readonly stashFileResults = new Map<string, readonly FileChange[]>();
  private readonly stashFileAbortControllers = new Map<string, AbortController>();
  private stashFilesLoader: StashFilesLoader | undefined;
  private readonly stashes = new Map<string, Promise<StashEntry[]>>();
  private readonly stashAbortControllers = new Map<string, AbortController>();
  private stashLoader: StashLoader | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setLoaders(stashLoader: StashLoader, stashFilesLoader: StashFilesLoader): void {
    this.stashFilesLoader = stashFilesLoader;
    this.stashLoader = stashLoader;
  }

  public getFilter(): string {
    return this.filter;
  }

  public setFilter(filter: string): void {
    const normalized = filter.trim().toLocaleLowerCase();
    if (normalized === this.filter) return;
    this.filter = normalized;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearCache();
    this.repositories = [];
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public setRepositories(repositories: readonly RepositoryIdentity[]): void {
    if (this.disposed) return;
    this.repositories = repositories;
    this.refresh();
  }

  public refresh(): void {
    this.clearCache();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: StashTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "repository":
        return createRepositoryItem(element.repository);
      case "stash":
        return this.createStashItem(element);
      case "folder":
        return createFolderItem(element);
      case "file":
        return createFileItem(element);
      case "message":
        return createMessageItem(element);
    }
  }

  public async getChildren(element?: StashTreeNode): Promise<StashTreeNode[]> {
    if (this.disposed) return [];
    if (!element) {
      if (this.repositories.length === 1) {
        const repository = this.repositories[0];
        return repository ? this.getStashNodes(repository, false) : [];
      }
      return this.repositories.map((repository) => ({ kind: "repository", repository }));
    }
    if (element.kind === "repository") return this.getStashNodes(element.repository, true);
    if (element.kind === "stash") return this.getStashChildren(element);
    if (element.kind === "folder") return getFolderChildren(element);
    return [];
  }

  private async getStashNodes(
    repository: RepositoryIdentity,
    showEmptyMessage: boolean,
  ): Promise<StashTreeNode[]> {
    if (!this.stashLoader) return [];
    const repositoryKey = pathIdentityKey(repository.rootPath);
    let pending = this.stashes.get(repositoryKey);
    if (!pending) {
      const controller = new AbortController();
      pending = this.stashLoader(repository.rootPath, controller.signal);
      this.stashes.set(repositoryKey, pending);
      this.stashAbortControllers.set(repositoryKey, controller);
    }
    try {
      const stashes = await pending;
      if (stashes.length === 0 && showEmptyMessage) {
        return [{ icon: "info", kind: "message", label: "No stashes in this repository." }];
      }
      const matches = stashes.filter((stash) => stashMatchesFilter(stash, this.filter));
      if (matches.length === 0 && this.filter.length > 0) {
        return [
          {
            icon: "search",
            kind: "message",
            label: `No stashes match “${this.filter}”.`,
          },
        ];
      }
      return matches.map((stash) => ({ kind: "stash", repository, stash }));
    } catch (error) {
      if (this.stashes.get(repositoryKey) === pending) {
        this.stashes.delete(repositoryKey);
        this.stashAbortControllers.delete(repositoryKey);
      }
      return [
        {
          icon: "error",
          kind: "message",
          label: "Could not list stashes. Use Refresh to try again.",
          ...(error instanceof Error ? { tooltip: error.message } : {}),
        },
      ];
    } finally {
      if (this.stashes.get(repositoryKey) === pending) {
        this.stashAbortControllers.delete(repositoryKey);
      }
    }
  }

  private async getStashChildren(element: StashNode): Promise<StashTreeNode[]> {
    if (!this.stashFilesLoader) return [];
    const { repository, stash } = element;
    const key = stashKey(repository.rootPath, stash.sha);
    let pending = this.stashFiles.get(key);
    const newlyRequested = pending === undefined;
    if (!pending) {
      const controller = new AbortController();
      pending = this.stashFilesLoader(
        repository.rootPath,
        stash.parentSha,
        stash.sha,
        controller.signal,
      );
      this.stashFiles.set(key, pending);
      this.stashFileAbortControllers.set(key, controller);
    }
    try {
      const files = await pending;
      this.stashFileResults.set(key, files);
      if (newlyRequested) this.onDidChangeTreeDataEmitter.fire(element);
      if (files.length === 0) {
        return [{ icon: "info", kind: "message", label: "No tracked file changes in this stash." }];
      }
      const scope: FileDiffScope = {
        fromSha: stash.parentSha,
        label: stash.selector,
        repositoryRootPath: repository.rootPath,
        toSha: stash.sha,
      };
      return buildChangeNodes(files, "tree", scope, `${repository.rootPath}:stash:${stash.sha}`);
    } catch (error) {
      if (this.stashFiles.get(key) === pending) {
        this.stashFiles.delete(key);
        this.stashFileAbortControllers.delete(key);
      }
      return [
        {
          icon: "error",
          kind: "message",
          label: "Could not load stash files. Collapse and expand to try again.",
          ...(error instanceof Error ? { tooltip: error.message } : {}),
        },
      ];
    } finally {
      if (this.stashFiles.get(key) === pending) this.stashFileAbortControllers.delete(key);
    }
  }

  private createStashItem(element: StashNode): vscode.TreeItem {
    const { repository, stash } = element;
    const files = this.stashFileResults.get(stashKey(repository.rootPath, stash.sha));
    const stats = files ? sumDiffTotals(files) : undefined;
    const item = new vscode.TreeItem(stash.message, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = "refhaven.stash";
    item.description = [
      stash.selector,
      ...(stash.branchName ? [`on ${stash.branchName}`] : []),
      ...(files ? [pluralize(files.length, "file")] : []),
      ...(stats ? [formatDiffStats(stats.additions, stats.deletions)] : []),
      formatRelativeTime(stash.authorDate),
    ].join(" · ");
    item.iconPath = new vscode.ThemeIcon("git-stash");
    item.id = `${repository.rootPath}:stash:${stash.sha}`;
    const tooltip = new vscode.MarkdownString(
      [
        `**${escapeMarkdown(stash.message)}**`,
        "",
        `$(git-stash) \`${stash.selector}\` · \`${shortSha(stash.sha)}\``,
        `$(git-commit) parent \`${shortSha(stash.parentSha)}\``,
        ...(stash.branchName
          ? [`$(git-branch) stashed on ${escapeMarkdown(stash.branchName)}`]
          : []),
        ...(files && stats
          ? [
              `$(files) ${pluralize(files.length, "changed file")} · ${formatDiffStats(stats.additions, stats.deletions)}`,
            ]
          : ["$(files) Expand to load changed-file statistics"]),
        `$(history) ${formatRelativeTime(stash.authorDate)} (${new Date(stash.authorDate).toLocaleString()})`,
        `$(repo) ${escapeMarkdown(repository.rootPath)}`,
      ].join("\n\n"),
    );
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    return item;
  }

  private clearCache(): void {
    for (const controller of this.stashFileAbortControllers.values()) controller.abort();
    for (const controller of this.stashAbortControllers.values()) controller.abort();
    this.stashFileAbortControllers.clear();
    this.stashAbortControllers.clear();
    this.stashFiles.clear();
    this.stashFileResults.clear();
    this.stashes.clear();
  }
}

function createRepositoryItem(repository: RepositoryIdentity): vscode.TreeItem {
  const item = new vscode.TreeItem(repository.label, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = new vscode.ThemeIcon("repo");
  item.id = `stashRepository:${repository.rootPath}`;
  item.tooltip = repository.rootPath;
  return item;
}

function stashKey(repositoryRoot: string, sha: string): string {
  return `${pathIdentityKey(repositoryRoot)}:${sha}`;
}

function stashMatchesFilter(stash: StashEntry, filter: string): boolean {
  if (filter.length === 0) return true;
  return [stash.message, stash.branchName ?? "", stash.selector, stash.sha].some((value) =>
    value.toLocaleLowerCase().includes(filter),
  );
}
