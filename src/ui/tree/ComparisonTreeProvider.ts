import { join } from "node:path";

import * as vscode from "vscode";

import { comparisonLabel, type SavedComparisonV1 } from "../../domain/comparison";
import type { ComparisonResult, FileChange } from "../../domain/comparisonResult";
import { COMMAND_IDS } from "../commands/commandIds";

export const COMPARISON_VIEW_ID = "branchCompare.comparisons";

interface ComparisonNode {
  readonly comparison: SavedComparisonV1;
  readonly kind: "comparison";
}

interface FileNode {
  readonly file: FileChange;
  readonly kind: "file";
  readonly result: ComparisonResult;
}

interface MessageNode {
  readonly icon: string;
  readonly kind: "message";
  readonly label: string;
}

type ComparisonTreeNode = ComparisonNode | FileNode | MessageNode;
type ComparisonLoader = (comparison: SavedComparisonV1) => Promise<ComparisonResult>;

export class ComparisonTreeProvider implements vscode.TreeDataProvider<ComparisonTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    ComparisonTreeNode | undefined
  >();
  private comparisons: readonly SavedComparisonV1[] = [];
  private comparisonLoader: ComparisonLoader | undefined;
  private readonly errors = new Map<string, string>();
  private generation = 0;
  private readonly pendingResults = new Map<string, Promise<ComparisonResult>>();
  private readonly results = new Map<string, ComparisonResult>();

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setComparisons(comparisons: readonly SavedComparisonV1[]): void {
    this.comparisons = comparisons;
    const validIds = new Set(comparisons.map(({ id }) => id));
    for (const id of this.results.keys()) if (!validIds.has(id)) this.results.delete(id);
    for (const id of this.errors.keys()) if (!validIds.has(id)) this.errors.delete(id);
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public setComparisonLoader(loader: ComparisonLoader): void {
    this.comparisonLoader = loader;
  }

  public invalidateResults(): void {
    this.generation += 1;
    this.errors.clear();
    this.pendingResults.clear();
    this.results.clear();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: ComparisonTreeNode): vscode.TreeItem {
    if (element.kind === "comparison") return this.createComparisonItem(element.comparison);
    if (element.kind === "file") return createFileItem(element);

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(element.icon);
    return item;
  }

  public async getChildren(element?: ComparisonTreeNode): Promise<ComparisonTreeNode[]> {
    if (!element) {
      return this.comparisons.map((comparison) => ({ comparison, kind: "comparison" }));
    }
    if (element.kind !== "comparison") return [];

    const result = await this.getComparisonResult(element.comparison);
    if (!result) {
      return [
        {
          icon: "error",
          kind: "message",
          label: this.errors.get(element.comparison.id) ?? "Comparison failed.",
        },
      ];
    }
    if (result.files.length === 0) {
      return [{ icon: "check", kind: "message", label: "No changed files" }];
    }
    return result.files.map((file) => ({ file, kind: "file", result }));
  }

  private createComparisonItem(comparison: SavedComparisonV1): vscode.TreeItem {
    const item = new vscode.TreeItem(
      comparisonLabel(comparison),
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const result = this.results.get(comparison.id);
    item.description = result
      ? `${comparison.repository.label} · ${result.files.length.toString()} files`
      : comparison.repository.label;
    item.iconPath = new vscode.ThemeIcon("git-compare");
    item.id = `comparison:${comparison.id}`;
    item.tooltip = [
      comparisonLabel(comparison),
      `Repository: ${comparison.repository.rootPath}`,
      `Base: ${comparison.baseRef.fullName}`,
      `Target: ${comparison.targetRef.fullName}`,
      `Mode: ${comparison.mode}`,
      ...(result ? [`Changed files: ${result.files.length.toString()}`] : []),
    ].join("\n");
    return item;
  }

  private async getComparisonResult(
    comparison: SavedComparisonV1,
  ): Promise<ComparisonResult | null> {
    const cached = this.results.get(comparison.id);
    if (cached) return cached;
    if (!this.comparisonLoader) throw new Error("Comparison loader is unavailable.");

    const generation = this.generation;
    let pending = this.pendingResults.get(comparison.id);
    if (!pending) {
      pending = this.comparisonLoader(comparison);
      this.pendingResults.set(comparison.id, pending);
    }

    try {
      const result = await pending;
      if (generation !== this.generation) return await this.getComparisonResult(comparison);
      this.results.set(comparison.id, result);
      this.errors.delete(comparison.id);
      this.onDidChangeTreeDataEmitter.fire(undefined);
      return result;
    } catch (error) {
      this.errors.set(comparison.id, error instanceof Error ? error.message : "Comparison failed.");
      return null;
    } finally {
      if (this.pendingResults.get(comparison.id) === pending) {
        this.pendingResults.delete(comparison.id);
      }
    }
  }
}

function createFileItem(element: FileNode): vscode.TreeItem {
  const { file, result } = element;
  const item = new vscode.TreeItem(file.newPath, vscode.TreeItemCollapsibleState.None);
  item.command = {
    arguments: [result, file],
    command: COMMAND_IDS.openFileDiff,
    title: "Open File Comparison",
  };
  item.contextValue = `branchCompare.file.${file.status}`;
  item.description = fileDescription(file);
  item.iconPath = new vscode.ThemeIcon(fileIcon(file.status));
  item.resourceUri = vscode.Uri.file(join(result.comparison.repository.rootPath, file.newPath));
  item.tooltip = file.oldPath
    ? `${file.oldPath} -> ${file.newPath}`
    : `${file.newPath} (${file.status})`;
  return item;
}

function fileDescription(file: FileChange): string {
  if (file.status === "renamed" || file.status === "copied") {
    const score = file.similarity === undefined ? "" : ` ${file.similarity.toString()}%`;
    return `${file.status}${score}`;
  }
  return file.status;
}

function fileIcon(status: FileChange["status"]): string {
  switch (status) {
    case "added":
    case "copied":
      return "diff-added";
    case "deleted":
      return "diff-removed";
    case "renamed":
      return "diff-renamed";
    case "modified":
    case "typeChanged":
    case "unmerged":
      return "diff-modified";
  }
}
