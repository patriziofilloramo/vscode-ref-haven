import { basename, dirname, relative } from "node:path";

import * as vscode from "vscode";

import type { Logger } from "./Logger";
import type { ComparisonController } from "./ComparisonController";
import { findRepositoryRoot, listLineHistory } from "../infrastructure/git/GitCli";
import {
  FILE_HISTORY_FOCUS_COMMAND,
  type FileHistoryNode,
  type FileHistoryTreeProvider,
} from "../ui/tree/FileHistoryTreeProvider";
import { formatRelativeTime } from "../ui/format";

export class FileHistoryController implements vscode.Disposable {
  private disposed = false;
  private generation = 0;

  public constructor(
    private readonly treeProvider: FileHistoryTreeProvider,
    private readonly treeView: vscode.TreeView<FileHistoryNode>,
    private readonly comparisonController: ComparisonController,
    private readonly logger: Logger,
  ) {}

  public async refresh(force = false): Promise<void> {
    const generation = ++this.generation;
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      this.applyTarget(undefined);
      return;
    }
    const repositoryRoot = await findRepositoryRoot(dirname(editor.document.uri.fsPath));
    if (this.disposed || generation !== this.generation) return;
    if (!repositoryRoot) {
      this.applyTarget(undefined);
      return;
    }
    const filePath = relative(repositoryRoot, editor.document.uri.fsPath).replaceAll("\\", "/");
    this.treeProvider.setTarget({ filePath, repositoryRoot });
    if (force) this.treeProvider.refresh();
    this.treeView.description = basename(filePath);
    this.treeView.message = "";
    this.logger.info("Refreshed file history target", { operation: "refreshFileHistory" });
  }

  public async showLineHistory(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Open a tracked file before viewing line history.");
      return;
    }
    const repositoryRoot = await findRepositoryRoot(dirname(editor.document.uri.fsPath));
    if (!repositoryRoot) {
      void vscode.window.showWarningMessage("The active file is not inside a Git repository.");
      return;
    }
    const filePath = relative(repositoryRoot, editor.document.uri.fsPath).replaceAll("\\", "/");
    const startLine = Math.min(editor.selection.start.line, editor.selection.end.line) + 1;
    const endLine = Math.max(editor.selection.start.line, editor.selection.end.line) + 1;
    await this.showLineHistoryAt(repositoryRoot, filePath, startLine, endLine);
  }

  public async showLineHistoryAt(
    repositoryRoot: string,
    filePath: string,
    startLine: number,
    endLine = startLine,
  ): Promise<void> {
    const commits = await listLineHistory(repositoryRoot, filePath, startLine, endLine);
    if (commits.length === 0) {
      void vscode.window.showInformationMessage("No commits were found for the selected lines.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      commits.map((commit) => ({
        commit,
        description: `${commit.authorName} · ${formatRelativeTime(commit.authorDate)}`,
        detail: commit.sha,
        label: `$(git-commit) ${commit.subject || "(no commit message)"}`,
      })),
      {
        placeHolder: `Select a revision for lines ${startLine.toString()}–${endLine.toString()}`,
        title: "RefHaven: Line History",
      },
    );
    if (!selected) return;
    await this.comparisonController.openFileAtRevision(
      repositoryRoot,
      selected.commit.sha,
      filePath,
    );
  }

  public async showFileHistory(
    repositoryRoot: string,
    filePath: string,
    force = true,
  ): Promise<void> {
    this.treeProvider.setTarget({ filePath, repositoryRoot });
    if (force) this.treeProvider.refresh();
    this.treeView.description = basename(filePath);
    this.treeView.message = "";
    await vscode.commands.executeCommand(FILE_HISTORY_FOCUS_COMMAND);
    this.logger.info("Opened file history", { operation: "showFileHistory" });
  }

  public openFileDiff(node: FileHistoryNode): Promise<void> {
    return this.comparisonController.openFileDiff(
      {
        fromSha: node.entry.parentSha,
        label: node.entry.commit.subject || node.entry.commit.sha.slice(0, 8),
        repositoryRootPath: node.target.repositoryRoot,
        toSha: node.entry.commit.sha,
      },
      node.entry.change,
    );
  }

  public openFileAtRevision(node: FileHistoryNode): Promise<void> {
    return this.comparisonController.openFileAtRevision(
      node.target.repositoryRoot,
      node.entry.commit.sha,
      node.entry.change.newPath,
    );
  }

  public dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }

  private applyTarget(target: undefined): void {
    this.treeProvider.setTarget(target);
    this.treeView.description = "";
    this.treeView.message = "Open a tracked file to view its history.";
  }
}
