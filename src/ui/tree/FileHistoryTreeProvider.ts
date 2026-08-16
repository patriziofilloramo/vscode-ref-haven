import * as vscode from "vscode";

import type { FileHistoryEntry, FileHistoryTarget } from "../../domain/history";
import { shortSha } from "../../domain/comparisonResult";
import { formatRelativeTime } from "../format";
import { escapeMarkdown } from "../markdown";
import { COMMAND_IDS } from "../commands/commandIds";

export const FILE_HISTORY_FOCUS_COMMAND = "refhaven.inspector.focus";

export interface FileHistoryNode {
  readonly entry: FileHistoryEntry;
  readonly kind: "fileHistoryCommit";
  readonly target: FileHistoryTarget;
}

type FileHistoryLoader = (
  repositoryRoot: string,
  filePath: string,
  signal: AbortSignal,
) => Promise<FileHistoryEntry[]>;

export class FileHistoryTreeProvider
  implements vscode.TreeDataProvider<FileHistoryNode>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    FileHistoryNode | undefined
  >();
  private abortController: AbortController | undefined;
  private disposed = false;
  private entries: Promise<FileHistoryEntry[]> | undefined;
  private filter = "";
  private loader: FileHistoryLoader | undefined;
  private target: FileHistoryTarget | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setLoader(loader: FileHistoryLoader): void {
    this.loader = loader;
  }

  public getFilter(): string {
    return this.filter;
  }

  public getTargetLabel(): string | undefined {
    const fileName = this.target?.filePath.split("/").at(-1);
    if (!fileName || !this.filter) return fileName;
    const visibleFilter =
      this.filter.length <= 32 ? this.filter : `${this.filter.slice(0, 31).trimEnd()}…`;
    return `${fileName} · Filter: ${visibleFilter}`;
  }

  public hasTarget(): boolean {
    return this.target !== undefined;
  }

  public setFilter(filter: string): void {
    const normalized = filter.trim().toLocaleLowerCase();
    if (normalized === this.filter) return;
    this.filter = normalized;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public setTarget(target: FileHistoryTarget | undefined): void {
    if (
      this.target?.repositoryRoot === target?.repositoryRoot &&
      this.target?.filePath === target?.filePath
    ) {
      return;
    }
    this.target = target;
    this.reset();
  }

  public refresh(): void {
    this.reset();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = undefined;
    this.entries = undefined;
    this.target = undefined;
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getTreeItem(node: FileHistoryNode): vscode.TreeItem {
    const { commit } = node.entry;
    const item = new vscode.TreeItem(commit.subject || "(no commit message)");
    item.command = {
      arguments: [node],
      command: COMMAND_IDS.openFileHistoryDiff,
      title: "Open File Change",
    };
    item.contextValue = "refhaven.fileHistoryCommit";
    item.description = `${commit.authorName} · ${formatRelativeTime(commit.authorDate)}`;
    item.iconPath = new vscode.ThemeIcon("git-commit");
    item.id = `fileHistory:${node.target.repositoryRoot}:${commit.sha}:${node.entry.change.newPath}`;
    const pathLine =
      node.entry.change.oldPath && node.entry.change.oldPath !== node.entry.change.newPath
        ? `$(file-symlink-file) ${escapeMarkdown(node.entry.change.oldPath)} → ${escapeMarkdown(node.entry.change.newPath)}`
        : `$(file) ${escapeMarkdown(node.entry.change.newPath)}`;
    const tooltip = new vscode.MarkdownString(
      [
        `**${escapeMarkdown(commit.subject || "(no commit message)")}**`,
        "",
        `$(git-commit) \`${shortSha(commit.sha)}\``,
        node.entry.parentSha
          ? `$(git-merge) parent \`${shortSha(node.entry.parentSha)}\``
          : "$(git-merge) root commit",
        `$(account) ${escapeMarkdown(commit.authorName)}`,
        `$(history) ${new Date(commit.authorDate).toLocaleString()}`,
        pathLine,
        "$(history) Rename tracking is enabled with local `git log --follow`.",
      ].join("\n\n"),
    );
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    return item;
  }

  public async getChildren(): Promise<FileHistoryNode[]> {
    const entries = await this.loadEntries();
    const target = this.target;
    if (!target) return [];
    return entries
      .filter((entry) => fileHistoryMatchesFilter(entry, this.filter))
      .map((entry) => ({ entry, kind: "fileHistoryCommit", target }));
  }

  public async getAdjacent(
    node: FileHistoryNode,
    direction: "next" | "previous",
  ): Promise<FileHistoryNode | undefined> {
    const visible = (await this.getChildren()).filter(
      ({ target }) =>
        target.repositoryRoot === node.target.repositoryRoot &&
        target.filePath === node.target.filePath,
    );
    const index = visible.findIndex(({ entry }) => entry.commit.sha === node.entry.commit.sha);
    if (index < 0) return undefined;
    const adjacent = visible[index + (direction === "next" ? 1 : -1)];
    return adjacent;
  }

  private async loadEntries(): Promise<FileHistoryEntry[]> {
    if (this.disposed || !this.target || !this.loader) return [];
    const target = this.target;
    if (!this.entries) {
      this.abortController = new AbortController();
      this.entries = this.loader(
        target.repositoryRoot,
        target.filePath,
        this.abortController.signal,
      );
    }
    return this.entries;
  }

  private reset(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    this.entries = undefined;
    if (!this.disposed) this.onDidChangeTreeDataEmitter.fire(undefined);
  }
}

function fileHistoryMatchesFilter(entry: FileHistoryEntry, filter: string): boolean {
  if (filter.length === 0) return true;
  return [
    entry.commit.subject,
    entry.commit.authorName,
    entry.commit.sha,
    entry.change.newPath,
    entry.change.oldPath ?? "",
  ].some((value) => value.toLocaleLowerCase().includes(filter));
}
