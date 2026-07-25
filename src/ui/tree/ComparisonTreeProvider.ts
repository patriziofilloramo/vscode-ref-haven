import type * as vscode from "vscode";

export const COMPARISON_VIEW_ID = "branchCompare.comparisons";

export class ComparisonTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): vscode.TreeItem[] {
    return [];
  }
}
