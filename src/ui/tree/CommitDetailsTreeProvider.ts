import * as vscode from "vscode";

import type { CommitDetails } from "../../domain/commitDetails";
import { sumDiffTotals, type CommitInfo, type FileChange } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import type { CommitFileChanges } from "../../infrastructure/git/GitCli";
import { COMMAND_IDS } from "../commands/commandIds";
import { formatDiffStats, formatRelativeTime } from "../format";
import { BROWSER_AUTOLINK_COMMANDS, escapeMarkdownWithAutolinks } from "../browserAutolinks";
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

export const COMMIT_DETAILS_FOCUS_COMMAND = "refhaven.inspector.focus";

export interface DetailNode {
  readonly commitSha: string;
  readonly copyValue: string;
  readonly description: string;
  readonly icon: string;
  readonly kind: "detail";
  readonly label: string;
  readonly parentSha?: string;
  readonly repositoryRoot: string;
  readonly tooltip?: string;
}

interface FilesSectionNode {
  readonly files: readonly FileChange[];
  readonly kind: "commitFiles";
  readonly scope: FileDiffScope;
}

export type CommitDetailsTreeNode =
  DetailNode | FileNode | FilesSectionNode | FolderNode | MessageNode;

type DetailsLoader = (
  repositoryRoot: string,
  sha: string,
  signal: AbortSignal,
) => Promise<CommitDetails>;
type FilesLoader = (
  repositoryRoot: string,
  sha: string,
  signal: AbortSignal,
) => Promise<CommitFileChanges>;

export class CommitDetailsTreeProvider
  implements vscode.TreeDataProvider<CommitDetailsTreeNode>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    CommitDetailsTreeNode | undefined
  >();
  private abortController: AbortController | undefined;
  private commit: CommitInfo | undefined;
  private detailsLoader: DetailsLoader | undefined;
  private disposed = false;
  private filesLoader: FilesLoader | undefined;
  private repositoryRoot: string | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public setLoaders(detailsLoader: DetailsLoader, filesLoader: FilesLoader): void {
    this.detailsLoader = detailsLoader;
    this.filesLoader = filesLoader;
  }

  public setCommit(repositoryRoot: string, commit: CommitInfo): void {
    this.abortController?.abort();
    this.abortController = undefined;
    this.repositoryRoot = repositoryRoot;
    this.commit = commit;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getCommitLabel(): string | undefined {
    return this.commit?.sha.slice(0, 8);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getTreeItem(node: CommitDetailsTreeNode): vscode.TreeItem {
    if (node.kind === "detail") {
      const item = new vscode.TreeItem(node.label);
      item.description = node.description;
      item.contextValue = node.parentSha ? "refhaven.commitParent" : "refhaven.commitDetail";
      item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.tooltip) {
        // Issue/MR shorthand in commit messages links to the approved GitLab
        // origin; trust is limited to that single command.
        const tooltip = new vscode.MarkdownString(
          escapeMarkdownWithAutolinks(node.tooltip, node.repositoryRoot),
        );
        tooltip.isTrusted = { enabledCommands: [...BROWSER_AUTOLINK_COMMANDS] };
        item.tooltip = tooltip;
      } else {
        item.tooltip = node.description;
      }
      if (node.parentSha) {
        item.command = {
          arguments: [node],
          command: COMMAND_IDS.openCommitParentDetails,
          title: "Open Parent Commit Details",
        };
      }
      return item;
    }
    if (node.kind === "commitFiles") {
      const item = new vscode.TreeItem(
        `Changed Files (${node.files.length.toString()})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      const totals = sumDiffTotals(node.files);
      item.description = formatDiffStats(totals.additions, totals.deletions);
      item.iconPath = new vscode.ThemeIcon("files");
      return item;
    }
    if (node.kind === "folder") return createFolderItem(node);
    if (node.kind === "file") return createFileItem(node);
    return createMessageItem(node);
  }

  public async getChildren(node?: CommitDetailsTreeNode): Promise<CommitDetailsTreeNode[]> {
    if (this.disposed) return [];
    if (node?.kind === "folder") return getFolderChildren(node);
    if (node?.kind === "commitFiles") {
      return buildChangeNodes(
        node.files,
        "tree",
        node.scope,
        `details:${node.scope.toSha ?? "worktree"}`,
      );
    }
    if (node) return [];
    if (!this.repositoryRoot || !this.commit || !this.detailsLoader || !this.filesLoader) return [];

    this.abortController?.abort();
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    const [details, changed] = await Promise.all([
      this.detailsLoader(this.repositoryRoot, this.commit.sha, signal),
      this.filesLoader(this.repositoryRoot, this.commit.sha, signal),
    ]);
    const scope: FileDiffScope = {
      fromSha: changed.parentSha,
      label: this.commit.subject || this.commit.sha.slice(0, 8),
      repositoryRootPath: this.repositoryRoot,
      toSha: this.commit.sha,
    };
    const context = { commitSha: this.commit.sha, repositoryRoot: this.repositoryRoot };
    return [
      detail(context, "Commit", this.commit.sha, "git-commit", this.commit.sha),
      detail(context, "Author", details.commit.authorName, "account", details.commit.authorName),
      detail(context, "Author Email", details.authorEmail, "mail", details.authorEmail),
      detail(
        context,
        "Author Date",
        `${formatRelativeTime(details.commit.authorDate)} · ${new Date(details.commit.authorDate).toLocaleString()}`,
        "calendar",
        new Date(details.commit.authorDate).toISOString(),
      ),
      detail(context, "Committer", details.committerName, "account", details.committerName),
      detail(context, "Committer Email", details.committerEmail, "mail", details.committerEmail),
      detail(
        context,
        "Committer Date",
        `${formatRelativeTime(details.committerDate)} · ${new Date(details.committerDate).toLocaleString()}`,
        "calendar",
        new Date(details.committerDate).toISOString(),
      ),
      ...(details.parentShas.length === 0
        ? [detail(context, "Parents", "root commit", "git-merge", "root commit")]
        : details.parentShas.map((parentSha, index) =>
            detail(
              context,
              `Parent ${(index + 1).toString()}`,
              parentSha,
              "git-merge",
              parentSha,
              parentSha,
            ),
          )),
      detail(
        context,
        "Message",
        details.fullMessage.split(/\r?\n/u)[0] ?? "(no commit message)",
        "comment-discussion",
        details.fullMessage,
        undefined,
        details.fullMessage,
      ),
      { files: changed.files, kind: "commitFiles", scope },
    ];
  }
}

function detail(
  context: { readonly commitSha: string; readonly repositoryRoot: string },
  label: string,
  description: string,
  icon: string,
  copyValue: string,
  parentSha?: string,
  tooltip?: string,
): DetailNode {
  return {
    ...context,
    copyValue,
    description,
    icon,
    kind: "detail",
    label,
    ...(parentSha ? { parentSha } : {}),
    ...(tooltip ? { tooltip } : {}),
  };
}
