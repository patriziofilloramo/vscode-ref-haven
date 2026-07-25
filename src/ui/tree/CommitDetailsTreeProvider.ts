import * as vscode from "vscode";

import type { CommitDetails } from "../../domain/commitDetails";
import type { CommitInfo, FileChange } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import type { CommitFileChanges } from "../../infrastructure/git/GitCli";
import { formatRelativeTime } from "../format";
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

export const COMMIT_DETAILS_VIEW_ID = "refhaven.commitDetails";
export const COMMIT_DETAILS_FOCUS_COMMAND = `${COMMIT_DETAILS_VIEW_ID}.focus`;

interface DetailNode {
  readonly description: string;
  readonly icon: string;
  readonly kind: "detail";
  readonly label: string;
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
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.tooltip ?? node.description;
      return item;
    }
    if (node.kind === "commitFiles") {
      const item = new vscode.TreeItem(
        `Changed Files (${node.files.length.toString()})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
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
    return [
      detail("Commit", this.commit.sha, "git-commit"),
      detail(
        "Author",
        `${details.commit.authorName} <${details.authorEmail}> · ${formatRelativeTime(details.commit.authorDate)}`,
        "account",
      ),
      detail(
        "Committer",
        `${details.committerName} <${details.committerEmail}> · ${formatRelativeTime(details.committerDate)}`,
        "account",
      ),
      detail(
        "Parents",
        details.parentShas.length === 0 ? "root commit" : details.parentShas.join(", "),
        "git-merge",
      ),
      detail(
        "Message",
        details.fullMessage.split(/\r?\n/u)[0] ?? "(no commit message)",
        "comment-discussion",
        details.fullMessage,
      ),
      { files: changed.files, kind: "commitFiles", scope },
    ];
  }
}

function detail(label: string, description: string, icon: string, tooltip?: string): DetailNode {
  return {
    description,
    icon,
    kind: "detail",
    label,
    ...(tooltip ? { tooltip: escapeMarkdown(tooltip) } : {}),
  };
}
