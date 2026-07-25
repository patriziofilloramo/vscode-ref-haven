import * as vscode from "vscode";

import { comparisonLabel, type SavedComparisonV1 } from "../../domain/comparison";
import {
  filterAndSortComparisonFiles,
  type ComparisonFileFilter,
  type ComparisonFileSort,
  type ComparisonReviewSummary,
} from "../../domain/comparisonReview";
import {
  COMMIT_PAGE_SIZE,
  shortSha,
  sumDiffTotals,
  type CommitInfo,
  type ComparisonResult,
} from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import type { CommitFileChanges } from "../../infrastructure/git/GitCli";
import { formatCount, formatDiffStats, formatRelativeTime, pluralize } from "../format";
import { escapeMarkdown } from "../markdown";
import {
  buildChangeNodes,
  createFileItem,
  createFolderItem,
  createMessageItem,
  getFolderChildren,
  type FileNode,
  type FilesLayout,
  type FolderNode,
  type MessageNode,
} from "./changeNodes";

export const COMPARISON_VIEW_ID = "refhaven.comparisons";
export const COMPARISON_VIEW_FOCUS_COMMAND = `${COMPARISON_VIEW_ID}.focus`;

export type { FilesLayout } from "./changeNodes";

export interface ComparisonNode {
  readonly comparison: SavedComparisonV1;
  readonly kind: "comparison";
}

export interface CommitTreeNode {
  readonly commit: CommitInfo;
  readonly comparisonId: string;
  readonly kind: "commit";
  readonly repositoryRoot: string;
}

interface SectionNode {
  readonly kind: "section";
  readonly result: ComparisonResult;
  readonly section: "ahead" | "behind" | "files";
}

export type ComparisonTreeNode =
  CommitTreeNode | ComparisonNode | FileNode | FolderNode | MessageNode | SectionNode;

type ComparisonLoader = (
  comparison: SavedComparisonV1,
  signal: AbortSignal,
) => Promise<ComparisonResult>;
type CommitFilesLoader = (
  repositoryRoot: string,
  sha: string,
  signal: AbortSignal,
) => Promise<CommitFileChanges>;
type ReviewStateProvider = (result: ComparisonResult) => ComparisonReviewSummary;

export class ComparisonTreeProvider
  implements vscode.TreeDataProvider<ComparisonTreeNode>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    ComparisonTreeNode | undefined
  >();
  private readonly commitFiles = new Map<string, Promise<CommitFileChanges>>();
  private readonly commitFilesAbortControllers = new Map<string, AbortController>();
  private commitFilesLoader: CommitFilesLoader | undefined;
  private comparisons: readonly SavedComparisonV1[] = [];
  private comparisonNodes: readonly ComparisonNode[] = [];
  private comparisonLoader: ComparisonLoader | undefined;
  private disposed = false;
  private readonly errors = new Map<string, string>();
  private readonly expansionRequests = new Set<string>();
  private fileFilter: ComparisonFileFilter = "all";
  private fileSort: ComparisonFileSort = "path";
  private filesLayout: FilesLayout = "tree";
  private readonly generations = new Map<string, number>();
  private readonly pendingResults = new Map<string, Promise<ComparisonResult>>();
  private readonly pendingResultAbortControllers = new Map<string, AbortController>();
  private readonly results = new Map<string, ComparisonResult>();
  private reviewStateProvider: ReviewStateProvider | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setComparisons(comparisons: readonly SavedComparisonV1[]): void {
    if (this.disposed) return;
    this.comparisons = comparisons;
    this.comparisonNodes = comparisons.map((comparison) => ({ comparison, kind: "comparison" }));
    const validIds = new Set(comparisons.map(({ id }) => id));
    for (const id of this.expansionRequests)
      if (!validIds.has(id)) this.expansionRequests.delete(id);
    for (const id of this.results.keys()) if (!validIds.has(id)) this.removeComparisonState(id);
    for (const id of this.pendingResults.keys())
      if (!validIds.has(id)) this.removeComparisonState(id);
    for (const id of this.errors.keys()) if (!validIds.has(id)) this.removeComparisonState(id);
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public setComparisonLoader(loader: ComparisonLoader): void {
    this.comparisonLoader = loader;
  }

  public setCommitFilesLoader(loader: CommitFilesLoader): void {
    this.commitFilesLoader = loader;
  }

  public setReviewStateProvider(provider: ReviewStateProvider): void {
    this.reviewStateProvider = provider;
  }

  public getComparisonNode(comparisonId: string): ComparisonNode | undefined {
    return this.comparisonNodes.find(({ comparison }) => comparison.id === comparisonId);
  }

  public async prepareComparison(comparisonId: string): Promise<void> {
    const comparison = this.currentComparison(comparisonId);
    if (!comparison) throw new Error("The comparison is not available in the RefHaven view.");
    await this.getComparisonResult(comparison);
  }

  public async loadComparisonResult(comparisonId: string): Promise<ComparisonResult> {
    const comparison = this.currentComparison(comparisonId);
    if (!comparison) throw new Error("The comparison is not available in the RefHaven view.");
    const result = await this.getComparisonResult(comparison);
    if (!result) throw new Error(this.errors.get(comparisonId) ?? "Comparison failed.");
    return result;
  }

  public requestComparisonExpansion(comparisonId: string): void {
    const node = this.getComparisonNode(comparisonId);
    if (!node) throw new Error("The comparison is not available in the RefHaven view.");
    this.expansionRequests.add(comparisonId);
    this.onDidChangeTreeDataEmitter.fire(node);
  }

  public clearComparisonExpansionRequest(comparisonId: string): void {
    this.expansionRequests.delete(comparisonId);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const comparison of this.comparisons) this.bumpGeneration(comparison.id);
    for (const controller of this.pendingResultAbortControllers.values()) controller.abort();
    for (const controller of this.commitFilesAbortControllers.values()) controller.abort();
    this.pendingResultAbortControllers.clear();
    this.commitFilesAbortControllers.clear();
    this.pendingResults.clear();
    this.commitFiles.clear();
    this.results.clear();
    this.errors.clear();
    this.expansionRequests.clear();
    this.comparisons = [];
    this.comparisonNodes = [];
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getFilesLayout(): FilesLayout {
    return this.filesLayout;
  }

  public setFilesLayout(layout: FilesLayout): void {
    if (this.filesLayout === layout) return;
    this.filesLayout = layout;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getFileFilter(): ComparisonFileFilter {
    return this.fileFilter;
  }

  public setFileFilter(filter: ComparisonFileFilter): void {
    if (this.fileFilter === filter) return;
    this.fileFilter = filter;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getFileSort(): ComparisonFileSort {
    return this.fileSort;
  }

  public setFileSort(sort: ComparisonFileSort): void {
    if (this.fileSort === sort) return;
    this.fileSort = sort;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public refreshReviewState(comparisonId: string): void {
    const node = this.getComparisonNode(comparisonId);
    this.onDidChangeTreeDataEmitter.fire(node);
  }

  public invalidateAllResults(): void {
    for (const comparison of this.comparisons) this.bumpGeneration(comparison.id);
    for (const controller of this.pendingResultAbortControllers.values()) controller.abort();
    for (const controller of this.commitFilesAbortControllers.values()) controller.abort();
    this.pendingResultAbortControllers.clear();
    this.commitFilesAbortControllers.clear();
    this.commitFiles.clear();
    this.errors.clear();
    this.pendingResults.clear();
    this.results.clear();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public invalidateResult(comparisonId: string): void {
    this.bumpGeneration(comparisonId);
    this.pendingResultAbortControllers.get(comparisonId)?.abort();
    this.pendingResultAbortControllers.delete(comparisonId);
    for (const controller of this.commitFilesAbortControllers.values()) controller.abort();
    this.commitFilesAbortControllers.clear();
    this.commitFiles.clear();
    this.errors.delete(comparisonId);
    this.pendingResults.delete(comparisonId);
    this.results.delete(comparisonId);
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: ComparisonTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "comparison":
        return this.createComparisonItem(element.comparison);
      case "section":
        return createSectionItem(element, this.reviewSummary(element.result), this.fileFilter);
      case "commit":
        return createCommitItem(element);
      case "folder":
        return createFolderItem(element);
      case "file":
        return createFileItem(element);
      case "message":
        return createMessageItem(element);
    }
  }

  public async getChildren(element?: ComparisonTreeNode): Promise<ComparisonTreeNode[]> {
    if (this.disposed) return [];
    if (!element) {
      return [...this.comparisonNodes];
    }

    switch (element.kind) {
      case "comparison":
        return this.getComparisonChildren(element.comparison);
      case "section":
        return this.getSectionChildren(element);
      case "commit":
        return this.getCommitChildren(element);
      case "folder":
        return getFolderChildren(element);
      default:
        return [];
    }
  }

  /**
   * VS Code rejects every TreeView.reveal call unless the provider implements
   * getParent, so without it new comparisons are never selected or expanded.
   * Reveal only targets comparison nodes (tree roots); deeper kinds resolve
   * as far as their data allows.
   */
  public getParent(element: ComparisonTreeNode): ComparisonTreeNode | undefined {
    switch (element.kind) {
      case "comparison":
        return undefined;
      case "section":
        return this.getComparisonNode(element.result.comparison.id);
      case "commit": {
        const result = this.results.get(element.comparisonId);
        if (!result) return undefined;
        const inAhead = result.aheadCommits.some(({ sha }) => sha === element.commit.sha);
        if (!inAhead && !result.behindCommits.some(({ sha }) => sha === element.commit.sha)) {
          return undefined;
        }
        return { kind: "section", result, section: inAhead ? "ahead" : "behind" };
      }
      default:
        return undefined;
    }
  }

  private async getComparisonChildren(
    comparison: SavedComparisonV1,
  ): Promise<ComparisonTreeNode[]> {
    const result = await this.getComparisonResult(comparison);
    if (!result) {
      return [
        {
          icon: "error",
          kind: "message",
          label: this.errors.get(comparison.id) ?? "Comparison failed.",
        },
      ];
    }
    return [
      { kind: "section", result, section: "behind" },
      { kind: "section", result, section: "ahead" },
      { kind: "section", result, section: "files" },
    ];
  }

  private async getCommitChildren(element: CommitTreeNode): Promise<ComparisonTreeNode[]> {
    if (!this.commitFilesLoader) return [];

    const key = `${element.repositoryRoot}:${element.commit.sha}`;
    let pending = this.commitFiles.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = this.commitFilesLoader(
        element.repositoryRoot,
        element.commit.sha,
        controller.signal,
      );
      this.commitFiles.set(key, pending);
      this.commitFilesAbortControllers.set(key, controller);
    }

    try {
      const { files, parentSha } = await pending;
      if (files.length === 0) {
        return [{ icon: "info", kind: "message", label: "No file changes in this commit." }];
      }
      const scope: FileDiffScope = {
        fromSha: parentSha,
        label: shortSha(element.commit.sha),
        repositoryRootPath: element.repositoryRoot,
        toSha: element.commit.sha,
      };
      return buildChangeNodes(
        files,
        this.filesLayout,
        scope,
        `${element.comparisonId}:commit:${element.commit.sha}`,
      );
    } catch (error) {
      if (this.commitFiles.get(key) === pending) {
        this.commitFiles.delete(key);
        this.commitFilesAbortControllers.delete(key);
      }
      return [
        {
          icon: "error",
          kind: "message",
          label: error instanceof Error ? error.message : "Could not load the commit files.",
        },
      ];
    } finally {
      if (this.commitFiles.get(key) === pending) this.commitFilesAbortControllers.delete(key);
    }
  }

  private createComparisonItem(comparison: SavedComparisonV1): vscode.TreeItem {
    const item = new vscode.TreeItem(
      comparisonLabel(comparison),
      this.expansionRequests.has(comparison.id)
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    const result = this.results.get(comparison.id);
    const error = this.errors.get(comparison.id);
    const review = result ? this.reviewSummary(result) : undefined;
    item.contextValue = comparison.pinned ? "refhaven.comparisonPinned" : "refhaven.comparison";
    item.description = comparisonDescription(comparison, result, review);
    item.iconPath = comparison.pinned
      ? new vscode.ThemeIcon("pinned")
      : new vscode.ThemeIcon("git-compare");
    item.id = `comparison:${comparison.id}`;
    item.tooltip = comparisonTooltip(comparison, result, error, review);
    return item;
  }

  private getSectionChildren(element: SectionNode): ComparisonTreeNode[] {
    const { result, section } = element;
    if (section !== "files") return getCommitSectionChildren(element);

    const review = this.reviewSummary(result);
    const files = filterAndSortComparisonFiles(
      result.files,
      review.reviewedPaths,
      this.fileFilter,
      this.fileSort,
    );
    if (files.length === 0 && result.files.length > 0) {
      return [
        {
          icon: "filter",
          kind: "message",
          label:
            this.fileFilter === "reviewed"
              ? "No reviewed files match the current filter."
              : "No unreviewed files remain.",
        },
      ];
    }
    return buildChangeNodes(
      files,
      this.filesLayout,
      comparisonDiffScope(result),
      `${result.comparison.id}:files`,
      {
        comparisonId: result.comparison.id,
        reviewedPaths: review.reviewedPaths,
        revisionKey: review.revisionKey,
      },
    );
  }

  private reviewSummary(result: ComparisonResult): ComparisonReviewSummary {
    return (
      this.reviewStateProvider?.(result) ?? {
        reviewedCount: 0,
        reviewedPaths: new Set<string>(),
        revisionKey: "",
        totalCount: result.files.length,
      }
    );
  }

  private async getComparisonResult(
    comparison: SavedComparisonV1,
  ): Promise<ComparisonResult | null> {
    if (!this.currentComparison(comparison.id)) return null;
    const cached = this.results.get(comparison.id);
    if (cached) return cached;
    if (this.errors.has(comparison.id)) return null;
    if (!this.comparisonLoader) throw new Error("Comparison loader is unavailable.");

    const generation = this.generations.get(comparison.id) ?? 0;
    let pending = this.pendingResults.get(comparison.id);
    if (!pending) {
      const controller = new AbortController();
      pending = this.comparisonLoader(comparison, controller.signal);
      this.pendingResults.set(comparison.id, pending);
      this.pendingResultAbortControllers.set(comparison.id, controller);
    }

    try {
      const result = await pending;
      if (generation !== (this.generations.get(comparison.id) ?? 0)) {
        const current = this.currentComparison(comparison.id);
        return current ? await this.getComparisonResult(current) : null;
      }
      this.results.set(comparison.id, result);
      this.errors.delete(comparison.id);
      this.onDidChangeTreeDataEmitter.fire(undefined);
      return result;
    } catch (error) {
      if (generation !== (this.generations.get(comparison.id) ?? 0)) {
        const current = this.currentComparison(comparison.id);
        return current ? await this.getComparisonResult(current) : null;
      }
      this.errors.set(comparison.id, error instanceof Error ? error.message : "Comparison failed.");
      return null;
    } finally {
      if (this.pendingResults.get(comparison.id) === pending) {
        this.pendingResults.delete(comparison.id);
        this.pendingResultAbortControllers.delete(comparison.id);
      }
    }
  }

  private bumpGeneration(comparisonId: string): void {
    this.generations.set(comparisonId, (this.generations.get(comparisonId) ?? 0) + 1);
  }

  private removeComparisonState(comparisonId: string): void {
    this.bumpGeneration(comparisonId);
    this.pendingResultAbortControllers.get(comparisonId)?.abort();
    this.pendingResultAbortControllers.delete(comparisonId);
    this.pendingResults.delete(comparisonId);
    this.results.delete(comparisonId);
    this.errors.delete(comparisonId);
  }

  private currentComparison(comparisonId: string): SavedComparisonV1 | undefined {
    return this.comparisons.find(({ id }) => id === comparisonId);
  }
}

/** Scope opening file diffs across the whole comparison (merge base → target). */
function comparisonDiffScope(result: ComparisonResult): FileDiffScope {
  return {
    fromSha: result.fromSha,
    label: `${result.comparison.targetRef.displayName} relative to ${result.comparison.baseRef.displayName}`,
    repositoryRootPath: result.comparison.repository.rootPath,
    toSha: result.toSha,
  };
}

function comparisonDescription(
  comparison: SavedComparisonV1,
  result: ComparisonResult | undefined,
  review: ComparisonReviewSummary | undefined,
): string {
  if (!result) return comparison.repository.label;
  const totals = sumDiffTotals(result.files);
  return [
    `↑${formatCount(result.aheadCount)} ↓${formatCount(result.behindCount)}`,
    pluralize(result.files.length, "file"),
    ...(review && review.totalCount > 0
      ? [`${review.reviewedCount.toString()}/${review.totalCount.toString()} reviewed`]
      : []),
    formatDiffStats(totals.additions, totals.deletions),
    ...(comparison.mode === "tipToTip"
      ? ["tip-to-tip"]
      : comparison.mode === "workingTree"
        ? ["working tree"]
        : []),
  ].join(" · ");
}

/** Explains WHY a comparison legitimately has no changed files. */
function emptyFilesDescription(result: ComparisonResult): string {
  const target = result.comparison.targetRef.displayName;
  if (result.aheadCount === 0 && result.behindCount === 0) {
    return "branches point at the same commit";
  }
  if (result.comparison.mode === "branchChanges" && result.aheadCount === 0) {
    return `${target} has no commits of its own`;
  }
  return "no differences";
}

function emptyFilesTooltip(result: ComparisonResult): string {
  const base = result.comparison.baseRef.displayName;
  const target = result.comparison.targetRef.displayName;
  if (result.aheadCount === 0 && result.behindCount === 0) {
    return `${target} and ${base} point at the same commit, so there is nothing to diff.`;
  }
  if (result.comparison.mode === "branchChanges" && result.aheadCount === 0) {
    return (
      `Branch-changes mode diffs the merge base against ${target}, and every commit of ` +
      `${target} is already part of ${base}. Swap base and target to see what ${base} adds, ` +
      `or switch the comparison to tip-to-tip mode to see the full difference.`
    );
  }
  return `The trees of ${base} and ${target} are identical for this comparison mode.`;
}

function comparisonTooltip(
  comparison: SavedComparisonV1,
  result: ComparisonResult | undefined,
  error: string | undefined,
  review: ComparisonReviewSummary | undefined,
): vscode.MarkdownString {
  const modeLabel =
    comparison.mode === "branchChanges"
      ? "branch changes (three-dot)"
      : comparison.mode === "tipToTip"
        ? "tip to tip (two-dot)"
        : "working tree";
  const lines = [
    `**${escapeMarkdown(comparison.targetRef.displayName)}** relative to **${escapeMarkdown(comparison.baseRef.displayName)}**`,
    `$(repo) ${escapeMarkdown(comparison.repository.label)} · ${modeLabel}`,
  ];

  if (result) {
    const totals = sumDiffTotals(result.files);
    lines.push(
      `$(git-commit) base \`${shortSha(result.baseSha)}\` → target \`${shortSha(result.targetSha)}\``,
      ...(result.mergeBaseSha
        ? [`$(git-merge) merge base \`${shortSha(result.mergeBaseSha)}\``]
        : []),
      `$(arrow-up) ${pluralize(result.aheadCount, "commit")} ahead · $(arrow-down) ${pluralize(result.behindCount, "commit")} behind`,
      `$(files) ${pluralize(result.files.length, "changed file")} · ${formatDiffStats(totals.additions, totals.deletions)}`,
      ...(review && review.totalCount > 0
        ? [
            `$(checklist) ${review.reviewedCount.toString()} of ${review.totalCount.toString()} files reviewed`,
          ]
        : []),
      ...(totals.binaryFileCount > 0
        ? [`$(file-binary) ${pluralize(totals.binaryFileCount, "binary file")}`]
        : []),
      `_Updated ${formatRelativeTime(result.computedAt)}_`,
    );
  } else if (error) {
    lines.push(`$(error) ${escapeMarkdown(error)}`);
  }

  const tooltip = new vscode.MarkdownString(lines.join("\n\n"));
  tooltip.supportThemeIcons = true;
  return tooltip;
}

function createSectionItem(
  element: SectionNode,
  review: ComparisonReviewSummary,
  filter: ComparisonFileFilter,
): vscode.TreeItem {
  const { result, section } = element;

  if (section === "files") {
    const totals = sumDiffTotals(result.files);
    const item = new vscode.TreeItem(
      `${pluralize(result.files.length, "file")} changed`,
      result.files.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description =
      result.files.length > 0
        ? [
            `${review.reviewedCount.toString()}/${review.totalCount.toString()} reviewed`,
            formatDiffStats(totals.additions, totals.deletions),
            ...(filter === "all" ? [] : [`filter: ${filter}`]),
          ].join(" · ")
        : emptyFilesDescription(result);
    if (result.files.length === 0) item.tooltip = emptyFilesTooltip(result);
    item.iconPath = new vscode.ThemeIcon("request-changes");
    item.id = `${result.comparison.id}:section:files`;
    return item;
  }

  const count = section === "ahead" ? result.aheadCount : result.behindCount;
  const item = new vscode.TreeItem(
    section === "ahead" ? "Ahead" : "Behind",
    count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
  );
  item.description = pluralize(count, "commit");
  item.iconPath = new vscode.ThemeIcon(section === "ahead" ? "arrow-up" : "arrow-down");
  item.id = `${result.comparison.id}:section:${section}`;
  item.tooltip =
    section === "ahead"
      ? `Commits only in ${result.comparison.targetRef.displayName}`
      : `Commits only in ${result.comparison.baseRef.displayName}`;
  return item;
}

function getCommitSectionChildren(element: SectionNode): ComparisonTreeNode[] {
  const { result, section } = element;

  if (section === "files") return [];

  const commits = section === "ahead" ? result.aheadCommits : result.behindCommits;
  const count = section === "ahead" ? result.aheadCount : result.behindCount;
  const nodes: ComparisonTreeNode[] = commits.map((commit) => ({
    commit,
    comparisonId: result.comparison.id,
    kind: "commit",
    repositoryRoot: result.comparison.repository.rootPath,
  }));
  if (count > commits.length) {
    nodes.push({
      icon: "ellipsis",
      kind: "message",
      label: `Showing the first ${formatCount(COMMIT_PAGE_SIZE)} of ${pluralize(count, "commit")}`,
    });
  }
  return nodes;
}

function createCommitItem(element: CommitTreeNode): vscode.TreeItem {
  const { commit } = element;
  const item = new vscode.TreeItem(commit.subject, vscode.TreeItemCollapsibleState.Collapsed);
  item.contextValue = "refhaven.commit";
  item.description = `${commit.authorName}, ${formatRelativeTime(commit.authorDate)}`;
  item.iconPath = new vscode.ThemeIcon("git-commit");
  item.id = `${element.comparisonId}:commit:${commit.sha}`;

  const tooltip = new vscode.MarkdownString(
    [
      `**${escapeMarkdown(commit.subject)}**`,
      "",
      `$(git-commit) \`${shortSha(commit.sha)}\``,
      `$(person) ${escapeMarkdown(commit.authorName)}`,
      `$(history) ${formatRelativeTime(commit.authorDate)} (${new Date(commit.authorDate).toLocaleString()})`,
    ].join("\n\n"),
  );
  tooltip.supportThemeIcons = true;
  item.tooltip = tooltip;
  return item;
}
