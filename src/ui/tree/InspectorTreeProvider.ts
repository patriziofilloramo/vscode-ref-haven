import * as vscode from "vscode";

import type { CommitDetailsTreeNode, CommitDetailsTreeProvider } from "./CommitDetailsTreeProvider";
import type { FileHistoryNode, FileHistoryTreeProvider } from "./FileHistoryTreeProvider";

export const INSPECTOR_VIEW_ID = "refhaven.inspector";
export const INSPECTOR_FOCUS_COMMAND = `${INSPECTOR_VIEW_ID}.focus`;

interface InspectorSectionNode {
  readonly kind: "inspectorSection";
  readonly section: "commitDetails" | "fileHistory";
}

interface InspectorMessageNode {
  readonly icon: "error" | "info";
  readonly kind: "inspectorMessage";
  readonly label: string;
  readonly tooltip?: string;
}

export type InspectorTreeNode =
  CommitDetailsTreeNode | FileHistoryNode | InspectorMessageNode | InspectorSectionNode;

const FILE_HISTORY_SECTION: InspectorSectionNode = {
  kind: "inspectorSection",
  section: "fileHistory",
};
const COMMIT_DETAILS_SECTION: InspectorSectionNode = {
  kind: "inspectorSection",
  section: "commitDetails",
};

/** Combines related read-only inspection providers into one Source Control view. */
export class InspectorTreeProvider
  implements vscode.TreeDataProvider<InspectorTreeNode>, vscode.Disposable
{
  private readonly disposables: vscode.Disposable[];
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    InspectorTreeNode | undefined
  >();

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly fileHistoryProvider: FileHistoryTreeProvider,
    private readonly commitDetailsProvider: CommitDetailsTreeProvider,
  ) {
    this.disposables = [
      fileHistoryProvider.onDidChangeTreeData(() =>
        this.onDidChangeTreeDataEmitter.fire(FILE_HISTORY_SECTION),
      ),
      commitDetailsProvider.onDidChangeTreeData(() =>
        this.onDidChangeTreeDataEmitter.fire(COMMIT_DETAILS_SECTION),
      ),
    ];
  }

  public dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getTreeItem(node: InspectorTreeNode): vscode.TreeItem {
    if (node.kind === "inspectorSection") {
      const isHistory = node.section === "fileHistory";
      const item = new vscode.TreeItem(
        isHistory ? "File History" : "Commit Details",
        vscode.TreeItemCollapsibleState.Expanded,
      );
      const description = isHistory
        ? this.fileHistoryProvider.getTargetLabel()
        : this.commitDetailsProvider.getCommitLabel();
      if (description) item.description = description;
      item.iconPath = new vscode.ThemeIcon(isHistory ? "history" : "inspect");
      item.id = `inspector:${node.section}`;
      return item;
    }
    if (node.kind === "inspectorMessage") {
      const item = new vscode.TreeItem(node.label);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.tooltip;
      return item;
    }
    return node.kind === "fileHistoryCommit"
      ? this.fileHistoryProvider.getTreeItem(node)
      : this.commitDetailsProvider.getTreeItem(node);
  }

  public async getChildren(node?: InspectorTreeNode): Promise<InspectorTreeNode[]> {
    if (!node) return [FILE_HISTORY_SECTION, COMMIT_DETAILS_SECTION];
    if (node.kind === "inspectorSection") {
      return node.section === "fileHistory"
        ? this.fileHistoryChildren()
        : this.commitDetailsChildren();
    }
    if (node.kind === "fileHistoryCommit" || node.kind === "inspectorMessage") return [];
    return this.commitDetailsProvider.getChildren(node);
  }

  /**
   * Ancestry is reported only where it is exact: nodes that sit directly
   * under a section. Files and folders nested below Changed Files do not
   * carry a parent reference, and nothing reveals them.
   */
  public getParent(node: InspectorTreeNode): InspectorTreeNode | undefined {
    if (node.kind === "fileHistoryCommit") return FILE_HISTORY_SECTION;
    if (node.kind === "detail" || node.kind === "commitFiles") return COMMIT_DETAILS_SECTION;
    return undefined;
  }

  private async fileHistoryChildren(): Promise<InspectorTreeNode[]> {
    try {
      const children = await this.fileHistoryProvider.getChildren();
      if (children.length > 0) return children;
      return [
        {
          icon: "info",
          kind: "inspectorMessage",
          label: fileHistoryEmptyMessage(this.fileHistoryProvider),
        },
      ];
    } catch (error) {
      return [errorMessage(error, "Could not load file history. Use Refresh to try again.")];
    }
  }

  private async commitDetailsChildren(): Promise<InspectorTreeNode[]> {
    try {
      const children = await this.commitDetailsProvider.getChildren();
      if (children.length > 0) return children;
      return [
        {
          icon: "info",
          kind: "inspectorMessage",
          label: "Select Show Commit Details from a commit or use Search Commits.",
        },
      ];
    } catch (error) {
      return [
        errorMessage(error, "Could not load commit details. Select the commit again to retry."),
      ];
    }
  }
}

function errorMessage(error: unknown, fallback: string): InspectorMessageNode {
  return {
    icon: "error",
    kind: "inspectorMessage",
    label: fallback,
    ...(error instanceof Error ? { tooltip: error.message } : {}),
  };
}

function fileHistoryEmptyMessage(provider: FileHistoryTreeProvider): string {
  if (!provider.hasTarget()) return "Open a tracked file to view its history.";
  const filter = provider.getFilter();
  return filter ? `No revisions match “${filter}”.` : "No file revisions found.";
}
