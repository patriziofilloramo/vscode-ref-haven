import * as vscode from "vscode";

import type { FileHistoryEntry, FileHistoryTarget } from "../../domain/history";
import { shortSha } from "../../domain/comparisonResult";
import { formatRelativeTime } from "../format";
import { escapeMarkdown } from "../markdown";
import { COMMAND_IDS } from "../commands/commandIds";

export const FILE_HISTORY_VIEW_ID = "refhaven.fileHistory";

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
  private loader: FileHistoryLoader | undefined;
  private target: FileHistoryTarget | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setLoader(loader: FileHistoryLoader): void {
    this.loader = loader;
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
    const tooltip = new vscode.MarkdownString(
      [
        `**${escapeMarkdown(commit.subject || "(no commit message)")}**`,
        "",
        `$(git-commit) \`${shortSha(commit.sha)}\``,
        `$(account) ${escapeMarkdown(commit.authorName)}`,
        `$(history) ${new Date(commit.authorDate).toLocaleString()}`,
        `$(file) ${escapeMarkdown(node.entry.change.newPath)}`,
      ].join("\n\n"),
    );
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    return item;
  }

  public async getChildren(): Promise<FileHistoryNode[]> {
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
    const entries = await this.entries;
    return entries.map((entry) => ({ entry, kind: "fileHistoryCommit", target }));
  }

  private reset(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    this.entries = undefined;
    if (!this.disposed) this.onDidChangeTreeDataEmitter.fire(undefined);
  }
}
