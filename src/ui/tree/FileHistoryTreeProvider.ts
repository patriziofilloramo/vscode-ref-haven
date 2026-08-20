import * as vscode from "vscode";

import { COMMIT_PAGE_SIZE, shortSha } from "../../domain/comparisonResult";
import {
  type HistoryEntry,
  type HistoryPage,
  type HistoryPageCursor,
  type HistoryPageRequest,
  type HistoryTarget,
  isFileHistoryEntry,
} from "../../domain/history";
import { COMMAND_IDS } from "../commands/commandIds";
import { formatRelativeTime } from "../format";
import { escapeMarkdown } from "../markdown";

export const FILE_HISTORY_FOCUS_COMMAND = "refhaven.inspector.focus";

interface HistoryCommitNodeBase {
  readonly entry: HistoryEntry;
  readonly target: HistoryTarget;
}

export interface FileHistoryCommitNode extends HistoryCommitNodeBase {
  readonly kind: "fileHistoryCommit";
}

export interface LineHistoryCommitNode extends HistoryCommitNodeBase {
  readonly kind: "lineHistoryCommit";
}

export type FileHistoryNode = FileHistoryCommitNode | LineHistoryCommitNode;

export interface HistoryLoadMoreNode {
  readonly kind: "historyLoadMore";
  readonly target: HistoryTarget;
}

export type HistoryTreeNode = FileHistoryNode | HistoryLoadMoreNode;

type FileHistoryLoader = (
  target: HistoryTarget,
  request: HistoryPageRequest,
  signal: AbortSignal,
) => Promise<HistoryPage>;

export class FileHistoryTreeProvider
  implements vscode.TreeDataProvider<HistoryTreeNode>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    HistoryTreeNode | undefined
  >();
  private abortController: AbortController | undefined;
  private disposed = false;
  private entries: HistoryEntry[] = [];
  private filter = "";
  private followRenames = true;
  private generation = 0;
  private hasLoaded = false;
  private hasMore = false;
  private loader: FileHistoryLoader | undefined;
  private loading: Promise<void> | undefined;
  private nextCursor: HistoryPageCursor | undefined;
  private pinned = false;
  private target: HistoryTarget | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setLoader(loader: FileHistoryLoader): void {
    this.loader = loader;
  }

  public getFilter(): string {
    return this.filter;
  }

  public getHistoryLabel(): "File History" | "Line History" {
    return this.target?.kind === "line" ? "Line History" : "File History";
  }

  public getSectionContextValue(): string {
    if (this.target?.kind === "line") {
      return `refhaven.lineHistorySection.lines.${this.pinned ? "pinned" : "unpinned"}`;
    }
    const follow = this.followRenames ? "followOn" : "followOff";
    return `refhaven.fileHistorySection.${follow}.${this.pinned ? "pinned" : "unpinned"}`;
  }

  public getSectionTooltip(): string {
    const target = this.target;
    if (!target) return "Open a tracked file to inspect its history.";
    const selection =
      target.kind === "line"
        ? `, lines ${target.startLine.toString()}–${target.endLine.toString()}`
        : "";
    const tracking =
      target.kind === "file" ? ` Rename tracking is ${this.followRenames ? "on" : "off"}.` : "";
    return `${target.filePath}${selection}. ${this.entries.length.toString()} revisions loaded. History is ${this.pinned ? "pinned" : "following the active editor"}.${tracking}`;
  }

  public getTargetLabel(): string | undefined {
    const target = this.target;
    const fileName = target?.filePath.split("/").at(-1);
    if (!fileName || !target) return undefined;
    const lineRange =
      target.kind === "line"
        ? `:${target.startLine.toString()}${target.endLine === target.startLine ? "" : `–${target.endLine.toString()}`}`
        : "";
    const state = [
      this.pinned ? "Pinned" : undefined,
      target.kind === "file" ? `Follow ${this.followRenames ? "on" : "off"}` : undefined,
      this.hasLoaded ? `${this.entries.length.toString()} loaded` : undefined,
      this.filter ? `Filter: ${visibleFilter(this.filter)}` : undefined,
    ].filter((value): value is string => value !== undefined);
    return `${fileName}${lineRange}${state.length > 0 ? ` · ${state.join(" · ")}` : ""}`;
  }

  public getTarget(): HistoryTarget | undefined {
    return this.target;
  }

  public hasTarget(): boolean {
    return this.target !== undefined;
  }

  public hasMoreRevisions(): boolean {
    return this.hasMore;
  }

  public isPinned(): boolean {
    return this.pinned;
  }

  public setFilter(filter: string): void {
    const normalized = filter.trim().toLocaleLowerCase();
    if (normalized === this.filter) return;
    this.filter = normalized;
    this.emitChange();
  }

  public setFollowRenames(enabled: boolean): void {
    if (enabled === this.followRenames) return;
    this.followRenames = enabled;
    if (this.target?.kind === "file") this.resetEntries();
    else this.emitChange();
  }

  public setPinned(pinned: boolean): void {
    if (pinned === this.pinned) return;
    this.pinned = pinned;
    this.emitChange();
  }

  public setTarget(target: HistoryTarget | undefined): void {
    if (sameHistoryTarget(this.target, target)) return;
    this.target = target;
    this.filter = "";
    this.resetEntries();
  }

  public refresh(): void {
    this.resetEntries();
  }

  public cancelActiveLoad(): void {
    this.abortController?.abort();
  }

  public async loadMore(node?: HistoryLoadMoreNode): Promise<void> {
    if (node && !sameHistoryTarget(node.target, this.target)) return;
    await this.ensurePageLoaded(this.entries.length);
    this.emitChange();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.entries = [];
    this.loading = undefined;
    this.target = undefined;
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getTreeItem(node: HistoryTreeNode): vscode.TreeItem {
    if (node.kind === "historyLoadMore") {
      const item = new vscode.TreeItem(
        this.filter ? "Load older revisions to continue search…" : "Load older revisions…",
      );
      item.command = {
        arguments: [node],
        command: COMMAND_IDS.loadMoreFileHistory,
        title: "Load Older Revisions",
      };
      item.contextValue = "refhaven.historyLoadMore";
      item.description = `${this.entries.length.toString()} loaded`;
      item.iconPath = new vscode.ThemeIcon("fold-down");
      item.id = `historyMore:${historyTargetIdentity(node.target)}:${this.entries.length.toString()}`;
      item.tooltip = this.filter
        ? "Load the next page; older revisions may also match the current filter."
        : "Load the next page of older revisions.";
      return item;
    }

    const { commit } = node.entry;
    const item = new vscode.TreeItem(commit.subject || "(no commit message)");
    item.command = {
      arguments: [node],
      command: COMMAND_IDS.openFileHistoryDiff,
      title: "Open File Change",
    };
    item.contextValue =
      node.kind === "lineHistoryCommit"
        ? "refhaven.lineHistoryCommit"
        : "refhaven.fileHistoryCommit";
    item.description = `${shortSha(commit.sha)} · ${commit.authorName} · ${formatRelativeTime(commit.authorDate)}`;
    item.iconPath = new vscode.ThemeIcon("git-commit");
    item.id = `history:${node.kind}:${historyTargetIdentity(node.target)}:${commit.sha}`;
    item.tooltip = this.commitTooltip(node);
    return item;
  }

  public async getChildren(): Promise<HistoryTreeNode[]> {
    await this.ensurePageLoaded(0);
    const target = this.target;
    if (!target) return [];
    const nodes: HistoryTreeNode[] = this.entries
      .filter((entry) => historyMatchesFilter(entry, target, this.filter))
      .map((entry) => ({
        entry,
        kind: target.kind === "line" ? "lineHistoryCommit" : "fileHistoryCommit",
        target,
      }));
    if (this.hasMore) nodes.push({ kind: "historyLoadMore", target });
    return nodes;
  }

  public async getAdjacent(
    node: FileHistoryNode,
    direction: "next" | "previous",
  ): Promise<FileHistoryNode | undefined> {
    const visible = await this.visibleCommitNodes(node.target);
    const index = visible.findIndex(({ entry }) => entry.commit.sha === node.entry.commit.sha);
    if (index < 0) return undefined;
    return visible[index + (direction === "next" ? 1 : -1)];
  }

  private commitTooltip(node: FileHistoryNode): vscode.MarkdownString {
    const { commit } = node.entry;
    const details = [
      `**${escapeMarkdown(commit.subject || "(no commit message)")}**`,
      "",
      `$(git-commit) \`${shortSha(commit.sha)}\``,
      node.entry.parentSha
        ? `$(git-merge) parent \`${shortSha(node.entry.parentSha)}\``
        : "$(git-merge) root commit",
      `$(account) ${escapeMarkdown(commit.authorName)}`,
      `$(history) ${new Date(commit.authorDate).toLocaleString()}`,
    ];
    if (isFileHistoryEntry(node.entry)) {
      details.push(
        node.entry.change.oldPath && node.entry.change.oldPath !== node.entry.change.newPath
          ? `$(file-symlink-file) ${escapeMarkdown(node.entry.change.oldPath)} → ${escapeMarkdown(node.entry.change.newPath)}`
          : `$(file) ${escapeMarkdown(node.entry.change.newPath)}`,
        `$(history) Rename tracking is ${this.followRenames ? "enabled" : "disabled"}.`,
      );
    } else if (node.target.kind === "line") {
      details.push(
        `$(selection) Lines ${node.target.startLine.toString()}–${node.target.endLine.toString()} in ${escapeMarkdown(node.target.filePath)}`,
      );
    }
    const tooltip = new vscode.MarkdownString(details.join("\n\n"));
    tooltip.supportThemeIcons = true;
    return tooltip;
  }

  private async ensurePageLoaded(offset: number): Promise<void> {
    if (
      this.disposed ||
      !this.target ||
      !this.loader ||
      (offset === 0 && this.hasLoaded) ||
      (offset > 0 && (!this.hasLoaded || !this.hasMore))
    ) {
      return;
    }
    if (this.loading) return this.loading;

    const target = this.target;
    const generation = this.generation;
    const abortController = new AbortController();
    this.abortController = abortController;
    const loading = this.loader(
      target,
      {
        cursor: this.nextCursor,
        followRenames: target.kind === "file" && this.followRenames,
        limit: COMMIT_PAGE_SIZE,
      },
      abortController.signal,
    )
      .then((page) => {
        if (
          this.disposed ||
          generation !== this.generation ||
          !sameHistoryTarget(target, this.target)
        ) {
          return;
        }
        const knownShas = new Set(this.entries.map(({ commit }) => commit.sha));
        const additions = page.entries.filter(({ commit }) => !knownShas.has(commit.sha));
        this.entries.push(...additions);
        this.hasLoaded = true;
        this.hasMore = page.hasMore && page.nextCursor !== undefined && additions.length > 0;
        this.nextCursor = this.hasMore ? page.nextCursor : undefined;
      })
      .finally(() => {
        if (this.loading === loading) {
          this.loading = undefined;
          this.abortController = undefined;
        }
      });
    this.loading = loading;
    return loading;
  }

  private resetEntries(): void {
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.entries = [];
    this.hasLoaded = false;
    this.hasMore = false;
    this.loading = undefined;
    this.nextCursor = undefined;
    this.emitChange();
  }

  private emitChange(): void {
    if (!this.disposed) this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  private async visibleCommitNodes(target: HistoryTarget): Promise<FileHistoryNode[]> {
    return (await this.getChildren()).filter(
      (candidate): candidate is FileHistoryNode =>
        candidate.kind !== "historyLoadMore" && sameHistoryTarget(candidate.target, target),
    );
  }
}

function historyMatchesFilter(entry: HistoryEntry, target: HistoryTarget, filter: string): boolean {
  if (filter.length === 0) return true;
  const values = [entry.commit.subject, entry.commit.authorName, entry.commit.sha, target.filePath];
  if (isFileHistoryEntry(entry)) values.push(entry.change.newPath, entry.change.oldPath ?? "");
  return values.some((value) => value.toLocaleLowerCase().includes(filter));
}

function historyTargetIdentity(target: HistoryTarget): string {
  const lines =
    target.kind === "line" ? `:${target.startLine.toString()}:${target.endLine.toString()}` : "";
  return `${target.kind}:${target.repositoryRoot}:${target.filePath}${lines}`;
}

function sameHistoryTarget(
  left: HistoryTarget | undefined,
  right: HistoryTarget | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : historyTargetIdentity(left) === historyTargetIdentity(right);
}

function visibleFilter(filter: string): string {
  return filter.length <= 32 ? filter : `${filter.slice(0, 31).trimEnd()}…`;
}
