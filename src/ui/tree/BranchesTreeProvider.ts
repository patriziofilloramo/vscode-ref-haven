import * as vscode from "vscode";

import type { BranchRef, RepositoryIdentity } from "../../domain/comparison";
import { shortSha, type CommitInfo } from "../../domain/comparisonResult";
import { pathIdentityKey } from "../../domain/pathValidation";
import type { BranchDetails } from "../../domain/repositoryNavigation";
import { COMMAND_IDS } from "../commands/commandIds";
import { formatRelativeTime } from "../format";
import { escapeMarkdown } from "../markdown";

export interface BranchRepositoryNode {
  readonly kind: "branchRepository";
  readonly repository: RepositoryIdentity;
}

export interface BranchNode {
  readonly branch: BranchRef;
  readonly current: boolean;
  readonly details: BranchDetails;
  readonly kind: "branch";
  readonly repository: RepositoryIdentity;
}

export interface BranchCommitNode {
  readonly commit: CommitInfo;
  readonly kind: "branchCommit";
  readonly repositoryRoot: string;
}

export interface BranchMessageNode {
  readonly kind: "branchMessage";
  readonly label: string;
}

export type BranchesTreeNode =
  BranchCommitNode | BranchMessageNode | BranchNode | BranchRepositoryNode;

export interface BranchSnapshot {
  readonly branches: readonly BranchDetails[];
  readonly currentBranchName: string | null;
}

type BranchLoader = (repositoryRoot: string, signal: AbortSignal) => Promise<BranchSnapshot>;
type BranchHistoryLoader = (
  repositoryRoot: string,
  revision: string,
  signal: AbortSignal,
) => Promise<CommitInfo[]>;

export class BranchesTreeProvider
  implements vscode.TreeDataProvider<BranchesTreeNode>, vscode.Disposable
{
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cache = new Map<string, Promise<BranchSnapshot>>();
  private disposed = false;
  private readonly historyAbortControllers = new Map<string, AbortController>();
  private readonly historyCache = new Map<string, Promise<CommitInfo[]>>();
  private historyLoader: BranchHistoryLoader | undefined;
  private loader: BranchLoader | undefined;
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    BranchesTreeNode | undefined
  >();
  private repositories: readonly RepositoryIdentity[] = [];

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setLoaders(loader: BranchLoader, historyLoader: BranchHistoryLoader): void {
    this.loader = loader;
    this.historyLoader = historyLoader;
  }

  public setRepositories(repositories: readonly RepositoryIdentity[]): void {
    if (this.disposed) return;
    this.repositories = repositories;
    this.refresh();
  }

  public refresh(): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
    for (const controller of this.historyAbortControllers.values()) controller.abort();
    this.historyAbortControllers.clear();
    this.historyCache.clear();
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
    if (element.kind === "branchCommit") {
      const item = new vscode.TreeItem(element.commit.subject || "(no commit message)");
      item.command = {
        arguments: [element],
        command: COMMAND_IDS.showCommitDetails,
        title: "Show Commit Details",
      };
      item.contextValue = "refhaven.branchCommit";
      item.description = `${shortSha(element.commit.sha)} · ${formatRelativeTime(element.commit.authorDate)}`;
      item.iconPath = new vscode.ThemeIcon("git-commit");
      item.id = `branchCommit:${element.repositoryRoot}:${element.commit.sha}`;
      item.tooltip = `${element.commit.authorName} · ${new Date(element.commit.authorDate).toLocaleString()}`;
      return item;
    }
    if (element.kind === "branchRepository") return repositoryItem(element.repository, "branches");
    const item = new vscode.TreeItem(
      element.branch.displayName,
      element.branch.kind === "localBranch"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.contextValue = element.current ? "refhaven.branchCurrent" : "refhaven.branch";
    item.description = branchDescription(element);
    item.iconPath = new vscode.ThemeIcon(
      element.current ? "check" : element.branch.kind === "remoteBranch" ? "cloud" : "git-branch",
    );
    item.id = `${element.repository.rootPath}:branch:${element.branch.fullName}`;
    item.tooltip = branchTooltip(element);
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
    if (element.kind === "branchRepository") return this.loadBranches(element.repository);
    if (element.kind === "branch" && element.branch.kind === "localBranch") {
      return this.loadBranchHistory(element);
    }
    return [];
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
      return snapshot.branches.map((details) => ({
        branch: details.branch,
        current:
          details.branch.kind === "localBranch" &&
          details.branch.displayName === snapshot.currentBranchName,
        details,
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

  private async loadBranchHistory(node: BranchNode): Promise<BranchesTreeNode[]> {
    if (!this.historyLoader) return [];
    const key = `${pathIdentityKey(node.repository.rootPath)}:${node.details.sha}`;
    let pending = this.historyCache.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = this.historyLoader(
        node.repository.rootPath,
        node.branch.fullName,
        controller.signal,
      );
      this.historyCache.set(key, pending);
      this.historyAbortControllers.set(key, controller);
    }
    try {
      const commits = await pending;
      return commits.map((commit) => ({
        commit,
        kind: "branchCommit",
        repositoryRoot: node.repository.rootPath,
      }));
    } catch (error) {
      if (this.historyCache.get(key) === pending) this.historyCache.delete(key);
      return [
        {
          kind: "branchMessage",
          label: error instanceof Error ? error.message : "Could not load branch history.",
        },
      ];
    } finally {
      if (this.historyCache.get(key) === pending) this.historyAbortControllers.delete(key);
    }
  }
}

function branchDescription(node: BranchNode): string {
  const { details } = node;
  return [
    ...(node.current ? ["current"] : []),
    ...(node.branch.kind === "remoteBranch" ? ["remote"] : []),
    ...(details.upstream
      ? [
          details.upstreamGone
            ? `${details.upstream} gone`
            : `${details.upstream} ↑${details.ahead.toString()} ↓${details.behind.toString()}`,
        ]
      : []),
    shortSha(details.sha),
    formatRelativeTime(details.latestCommit.authorDate),
  ].join(" · ");
}

function branchTooltip(node: BranchNode): vscode.MarkdownString {
  const { details } = node;
  const tooltip = new vscode.MarkdownString(
    [
      `**${escapeMarkdown(node.branch.displayName)}**`,
      "",
      `$(git-commit) \`${shortSha(details.sha)}\` · ${escapeMarkdown(details.latestCommit.subject)}`,
      `$(account) ${escapeMarkdown(details.latestCommit.authorName)} · ${formatRelativeTime(details.latestCommit.authorDate)}`,
      ...(details.upstream
        ? [
            details.upstreamGone
              ? `$(warning) upstream ${escapeMarkdown(details.upstream)} is gone`
              : `$(cloud) ${escapeMarkdown(details.upstream)} · ↑${details.ahead.toString()} ↓${details.behind.toString()}`,
          ]
        : []),
      `$(repo) ${escapeMarkdown(node.repository.rootPath)}`,
    ].join("\n\n"),
  );
  tooltip.supportThemeIcons = true;
  return tooltip;
}

function repositoryItem(repository: RepositoryIdentity, suffix: string): vscode.TreeItem {
  const item = new vscode.TreeItem(repository.label, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = new vscode.ThemeIcon("repo");
  item.id = `${suffix}:${repository.rootPath}`;
  item.tooltip = repository.rootPath;
  return item;
}
