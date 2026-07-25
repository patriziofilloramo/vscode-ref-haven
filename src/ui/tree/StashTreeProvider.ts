import * as vscode from "vscode";

import type { RepositoryIdentity } from "../../domain/comparison";
import { shortSha, type FileChange } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import type { StashEntry } from "../../domain/stash";
import { formatRelativeTime } from "../format";
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

export const STASH_VIEW_ID = "branchCompare.stashes";

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

type StashLoader = (repositoryRoot: string) => Promise<StashEntry[]>;
type StashFilesLoader = (
  repositoryRoot: string,
  fromSha: string,
  toSha: string,
) => Promise<FileChange[]>;

export class StashTreeProvider implements vscode.TreeDataProvider<StashTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    StashTreeNode | undefined
  >();
  private repositories: readonly RepositoryIdentity[] = [];
  private readonly stashFiles = new Map<string, Promise<FileChange[]>>();
  private stashFilesLoader: StashFilesLoader | undefined;
  private readonly stashes = new Map<string, Promise<StashEntry[]>>();
  private stashLoader: StashLoader | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setLoaders(stashLoader: StashLoader, stashFilesLoader: StashFilesLoader): void {
    this.stashFilesLoader = stashFilesLoader;
    this.stashLoader = stashLoader;
  }

  public setRepositories(repositories: readonly RepositoryIdentity[]): void {
    this.repositories = repositories;
    this.refresh();
  }

  public refresh(): void {
    this.stashFiles.clear();
    this.stashes.clear();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: StashTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "repository":
        return createRepositoryItem(element.repository);
      case "stash":
        return createStashItem(element);
      case "folder":
        return createFolderItem(element);
      case "file":
        return createFileItem(element);
      case "message":
        return createMessageItem(element);
    }
  }

  public async getChildren(element?: StashTreeNode): Promise<StashTreeNode[]> {
    if (!element) {
      if (this.repositories.length === 1) {
        const repository = this.repositories[0];
        return repository ? this.getStashNodes(repository, false) : [];
      }
      return this.repositories.map((repository) => ({ kind: "repository", repository }));
    }

    switch (element.kind) {
      case "repository":
        return this.getStashNodes(element.repository, true);
      case "stash":
        return this.getStashChildren(element);
      case "folder":
        return getFolderChildren(element);
      default:
        return [];
    }
  }

  private async getStashNodes(
    repository: RepositoryIdentity,
    showEmptyMessage: boolean,
  ): Promise<StashTreeNode[]> {
    if (!this.stashLoader) return [];

    let pending = this.stashes.get(repository.rootPath);
    if (!pending) {
      pending = this.stashLoader(repository.rootPath);
      this.stashes.set(repository.rootPath, pending);
    }

    try {
      const stashes = await pending;
      if (stashes.length === 0 && showEmptyMessage) {
        return [{ icon: "info", kind: "message", label: "No stashes in this repository." }];
      }
      return stashes.map((stash) => ({ kind: "stash", repository, stash }));
    } catch (error) {
      this.stashes.delete(repository.rootPath);
      return [
        {
          icon: "error",
          kind: "message",
          label: error instanceof Error ? error.message : "Could not list the stashes.",
        },
      ];
    }
  }

  private async getStashChildren(element: StashNode): Promise<StashTreeNode[]> {
    if (!this.stashFilesLoader) return [];

    const { repository, stash } = element;
    let pending = this.stashFiles.get(stash.sha);
    if (!pending) {
      pending = this.stashFilesLoader(repository.rootPath, stash.parentSha, stash.sha);
      this.stashFiles.set(stash.sha, pending);
    }

    try {
      const files = await pending;
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
      this.stashFiles.delete(stash.sha);
      return [
        {
          icon: "error",
          kind: "message",
          label: error instanceof Error ? error.message : "Could not load the stash files.",
        },
      ];
    }
  }
}

function createRepositoryItem(repository: RepositoryIdentity): vscode.TreeItem {
  const item = new vscode.TreeItem(repository.label, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = new vscode.ThemeIcon("repo");
  item.id = `stashRepository:${repository.rootPath}`;
  item.tooltip = repository.rootPath;
  return item;
}

function createStashItem(element: StashNode): vscode.TreeItem {
  const { repository, stash } = element;
  const item = new vscode.TreeItem(stash.message, vscode.TreeItemCollapsibleState.Collapsed);
  item.contextValue = "branchCompare.stash";
  item.description = [
    stash.selector,
    ...(stash.branchName ? [`on ${stash.branchName}`] : []),
    formatRelativeTime(stash.authorDate),
  ].join(" · ");
  item.iconPath = new vscode.ThemeIcon("git-stash");
  item.id = `${repository.rootPath}:stash:${stash.sha}`;

  const tooltip = new vscode.MarkdownString(
    [
      `**${stash.message}**`,
      "",
      `$(git-stash) \`${stash.selector}\` · \`${shortSha(stash.sha)}\``,
      ...(stash.branchName ? [`$(git-branch) stashed on ${stash.branchName}`] : []),
      `$(history) ${formatRelativeTime(stash.authorDate)} (${new Date(stash.authorDate).toLocaleString()})`,
    ].join("\n\n"),
  );
  tooltip.supportThemeIcons = true;
  item.tooltip = tooltip;
  return item;
}
