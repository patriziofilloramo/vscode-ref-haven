import * as vscode from "vscode";

import { isFileHistoryEntry } from "../domain/history";
import { MAX_INTERACTIVE_INPUT_LENGTH } from "../domain/inputLimits";
import { resolveWorkspaceRepositoryFile } from "../infrastructure/git/GitCli";
import { GitOperationError } from "../infrastructure/git/GitProcess";
import {
  FILE_HISTORY_FOCUS_COMMAND,
  type FileHistoryNode,
  type FileHistoryTreeProvider,
  type HistoryLoadMoreNode,
} from "../ui/tree/FileHistoryTreeProvider";
import type { ComparisonController } from "./ComparisonController";
import type { Logger } from "./Logger";

const FOLLOW_RENAMES_STATE_KEY = "refhaven.fileHistory.followRenames";

export class FileHistoryController implements vscode.Disposable {
  private disposed = false;
  private generation = 0;

  public constructor(
    private readonly treeProvider: FileHistoryTreeProvider,
    private readonly comparisonController: ComparisonController,
    private readonly workspaceState: vscode.Memento,
    private readonly logger: Logger,
  ) {
    treeProvider.setFollowRenames(workspaceState.get(FOLLOW_RENAMES_STATE_KEY, true));
  }

  public async refresh(force = false): Promise<void> {
    if (this.treeProvider.isPinned()) {
      if (force) this.treeProvider.refresh();
      return;
    }
    const generation = ++this.generation;
    const editor = vscode.window.activeTextEditor;
    // History diffs use virtual documents. Keep the current target while the
    // user inspects them instead of erasing the view on every diff navigation.
    if (editor?.document.uri.scheme !== "file") return;
    const target = await resolveWorkspaceRepositoryFile(editor.document.uri.fsPath);
    if (this.disposed || generation !== this.generation) return;
    this.treeProvider.setTarget(
      target
        ? { filePath: target.filePath, kind: "file", repositoryRoot: target.repositoryRoot }
        : undefined,
    );
    if (force) this.treeProvider.refresh();
    this.logger.info("Refreshed history target", { operation: "refreshFileHistory" });
  }

  public async showLineHistory(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Open a tracked file before viewing line history.");
      return;
    }
    const target = await resolveWorkspaceRepositoryFile(editor.document.uri.fsPath);
    if (!target) {
      void vscode.window.showWarningMessage("The active file is not inside a Git repository.");
      return;
    }
    const startLine = Math.min(editor.selection.start.line, editor.selection.end.line) + 1;
    const endLine = Math.max(editor.selection.start.line, editor.selection.end.line) + 1;
    await this.showLineHistoryAt(target.repositoryRoot, target.filePath, startLine, endLine);
  }

  public async showLineHistoryAt(
    repositoryRoot: string,
    filePath: string,
    startLine: number,
    endLine = startLine,
  ): Promise<void> {
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      throw new Error("The selected line range is invalid.");
    }
    this.treeProvider.setTarget({ endLine, filePath, kind: "line", repositoryRoot, startLine });
    this.treeProvider.setPinned(true);
    await vscode.commands.executeCommand(FILE_HISTORY_FOCUS_COMMAND);
    this.logger.info("Opened line history", { operation: "showLineHistory" });
  }

  public async showFileHistory(
    repositoryRoot: string,
    filePath: string,
    force = true,
  ): Promise<void> {
    this.treeProvider.setTarget({ filePath, kind: "file", repositoryRoot });
    if (force) this.treeProvider.refresh();
    await vscode.commands.executeCommand(FILE_HISTORY_FOCUS_COMMAND);
    this.logger.info("Opened file history", { operation: "showFileHistory" });
  }

  public async showCurrentFileHistory(): Promise<void> {
    const target = this.treeProvider.getTarget();
    if (!target) {
      void vscode.window.showWarningMessage("Open a tracked file before viewing file history.");
      return;
    }
    await this.showFileHistory(target.repositoryRoot, target.filePath, false);
  }

  public openFileDiff(node: FileHistoryNode): Promise<void> {
    const change = isFileHistoryEntry(node.entry)
      ? node.entry.change
      : { newPath: node.target.filePath, status: "modified" as const };
    return this.comparisonController.openFileDiff(
      {
        fromSha: node.entry.parentSha,
        label: node.entry.commit.subject || node.entry.commit.sha.slice(0, 8),
        repositoryRootPath: node.target.repositoryRoot,
        toSha: node.entry.commit.sha,
      },
      change,
    );
  }

  public openFileAtRevision(node: FileHistoryNode): Promise<void> {
    const filePath = isFileHistoryEntry(node.entry)
      ? node.entry.change.newPath
      : node.target.filePath;
    return this.comparisonController.openFileAtRevision(
      node.target.repositoryRoot,
      node.entry.commit.sha,
      filePath,
    );
  }

  public async changeFilter(): Promise<void> {
    const filter = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "Commit message, author, SHA, or path",
      prompt: "Filters loaded revisions; use Load older revisions to search further back",
      title: `RefHaven: Filter ${this.treeProvider.getHistoryLabel()}`,
      value: this.treeProvider.getFilter(),
      validateInput: (value) =>
        value.length > MAX_INTERACTIVE_INPUT_LENGTH ? "Filter is too long." : undefined,
    });
    if (filter === undefined) return;
    this.treeProvider.setFilter(filter);
  }

  public async loadMore(node?: HistoryLoadMoreNode): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          cancellable: true,
          location: vscode.ProgressLocation.Notification,
          title: `RefHaven: Loading older ${this.treeProvider.getHistoryLabel().toLocaleLowerCase()} revisions…`,
        },
        async (_progress, token) => {
          const cancellation = token.onCancellationRequested(() =>
            this.treeProvider.cancelActiveLoad(),
          );
          try {
            await this.treeProvider.loadMore(node);
          } finally {
            cancellation.dispose();
          }
        },
      );
    } catch (error) {
      if (error instanceof GitOperationError && error.code === "commandCancelled") return;
      throw error;
    }
  }

  public async setFollowRenames(enabled: boolean): Promise<void> {
    this.treeProvider.setFollowRenames(enabled);
    await this.workspaceState.update(FOLLOW_RENAMES_STATE_KEY, enabled);
    void vscode.window.setStatusBarMessage(
      `RefHaven: Rename tracking ${enabled ? "enabled" : "disabled"}`,
      3_000,
    );
    this.logger.info("Changed file history rename tracking", {
      enabled,
      operation: "setFileHistoryFollowRenames",
    });
  }

  public async setPinned(pinned: boolean): Promise<void> {
    this.treeProvider.setPinned(pinned);
    if (!pinned) await this.refresh();
  }

  public async openAdjacent(node: FileHistoryNode, direction: "next" | "previous"): Promise<void> {
    let adjacent = await this.treeProvider.getAdjacent(node, direction);
    if (!adjacent && direction === "next" && this.treeProvider.hasMoreRevisions()) {
      await this.loadMore();
      adjacent = await this.treeProvider.getAdjacent(node, direction);
    }
    if (!adjacent) {
      void vscode.window.showInformationMessage(
        direction === "next"
          ? "This is the oldest loaded revision."
          : "This is the newest visible revision.",
      );
      return;
    }
    await this.openFileDiff(adjacent);
  }

  public dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }
}
