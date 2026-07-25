import * as vscode from "vscode";

import type { FileChange } from "../domain/comparisonResult";
import type { FileDiffScope } from "../domain/fileDiffScope";
import {
  listComparisonRefs,
  listWorkingTreeFileChanges,
  readCurrentBranch,
  resolveRef,
} from "../infrastructure/git/GitCli";
import { COMMAND_IDS } from "../ui/commands/commandIds";
import {
  activateFileContextTarget,
  asFileNode,
  resolveFileContextTarget,
  resolveKnownFileTarget,
  type FileContextTarget,
} from "../ui/commands/fileContext";
import { pickBranch } from "../ui/pickers/comparisonPickers";
import type { ComparisonController } from "./ComparisonController";
import type { FileAnnotationsController } from "./FileAnnotationsController";
import type { FileHistoryController } from "./FileHistoryController";
import type { Logger } from "./Logger";

interface FileActionItem extends vscode.QuickPickItem {
  readonly run: () => Thenable<unknown>;
}

export class FileActionsController {
  public constructor(
    private readonly comparisonController: ComparisonController,
    private readonly fileAnnotationsController: FileAnnotationsController,
    private readonly fileHistoryController: FileHistoryController,
    private readonly logger: Logger,
  ) {}

  public async showMenu(candidate?: unknown): Promise<void> {
    const target = await resolveFileContextTarget(candidate);
    if (!target) {
      void vscode.window.showWarningMessage("Select a file inside a Git repository first.");
      return;
    }
    const commandArgument = asFileNode(candidate) ?? target.uri;
    const selected = await vscode.window.showQuickPick<FileActionItem>(
      [
        {
          detail: target.filePath,
          label: "$(history) Show File History",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.showFileHistory, commandArgument),
        },
        {
          detail: "Inspect commits for the current selection",
          label: "$(list-selection) Show Line History",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.showLineHistory, target.uri),
        },
        {
          detail: "Open the file from a local Git reference",
          label: "$(go-to-file) Open File at Revision...",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.openFileAtRevision, target.uri),
        },
        {
          detail: "Use VS Code's native diff editor",
          label: "$(compare-changes) Compare File with Revision...",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.compareFileWithRevision, target.uri),
        },
        {
          detail: "Blame, heatmap, changes, or off",
          label: "$(symbol-color) Change File Annotations...",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.changeFileAnnotations, target.uri),
        },
        {
          detail: "Search commit messages, authors, SHAs, or changed content",
          label: "$(search) Search Commits...",
          run: (): Thenable<unknown> => vscode.commands.executeCommand(COMMAND_IDS.searchCommits),
        },
      ],
      {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: target.filePath,
        title: "RefHaven: File Actions",
      },
    );
    await selected?.run();
  }

  public async showFileHistory(candidate?: unknown): Promise<void> {
    const target = await this.requireTarget(candidate);
    await this.fileHistoryController.showFileHistory(target.repositoryRoot, target.filePath);
  }

  public async showFileHistoryAt(repositoryRoot: unknown, filePath: unknown): Promise<void> {
    const target = await this.requireKnownTarget(repositoryRoot, filePath);
    await this.fileHistoryController.showFileHistory(target.repositoryRoot, target.filePath);
  }

  public async showLineHistory(candidate?: unknown): Promise<void> {
    const target = await this.requireTarget(candidate);
    if (!(await activateFileContextTarget(target))) {
      throw new Error("The selected file does not exist in the working tree.");
    }
    await this.fileHistoryController.showLineHistory();
  }

  public async showLineHistoryAt(
    repositoryRoot: unknown,
    filePath: unknown,
    lineNumber: unknown,
  ): Promise<void> {
    const target = await this.requireKnownTarget(repositoryRoot, filePath);
    if (!Number.isSafeInteger(lineNumber) || (lineNumber as number) < 1) {
      throw new Error("The selected line is invalid.");
    }
    await this.fileHistoryController.showLineHistoryAt(
      target.repositoryRoot,
      target.filePath,
      lineNumber as number,
    );
  }

  public async changeAnnotations(candidate?: unknown): Promise<void> {
    const target = await this.requireTarget(candidate);
    if (!(await activateFileContextTarget(target))) {
      throw new Error("The selected file does not exist in the working tree.");
    }
    await this.fileAnnotationsController.changeAnnotations();
  }

  public async openFileAtRevision(candidate?: unknown): Promise<void> {
    const target = await this.requireTarget(candidate);
    const fileNode = asFileNode(candidate);
    if (fileNode) {
      await this.comparisonController.openChangedFileAtRevision(fileNode.scope, fileNode.file);
      return;
    }
    if (!(await activateFileContextTarget(target))) {
      throw new Error("The selected file does not exist in the working tree.");
    }
    await this.comparisonController.openFileAtRevision();
  }

  public async openLineDiff(scope: unknown, file: unknown): Promise<void> {
    const candidateScope = scope as Partial<FileDiffScope> | undefined;
    const candidateFile = file as Partial<FileChange> | undefined;
    await this.requireKnownTarget(candidateScope?.repositoryRootPath, candidateFile?.newPath);
    await this.comparisonController.openFileDiff(scope as FileDiffScope, file as FileChange);
  }

  public async compareFileWithRevision(candidate?: unknown): Promise<void> {
    const target = await this.requireTarget(candidate);
    const refs = await listComparisonRefs(target.repositoryRoot);
    if (refs.length === 0) {
      void vscode.window.showInformationMessage("This repository has no local references.");
      return;
    }
    const currentBranchName = await readCurrentBranch(target.repositoryRoot);
    const ref = await pickBranch(
      refs,
      `Select the revision to compare with ${target.filePath}`,
      currentBranchName,
      target.repositoryRoot,
      false,
      "RefHaven: Compare File with Revision",
    );
    if (!ref) return;
    const sha = await resolveRef(target.repositoryRoot, ref.fullName);
    await this.compareTargetWithRevision(target, sha, ref.displayName);
  }

  public async compareFileWithRevisionAt(
    repositoryRoot: unknown,
    sha: unknown,
    filePath: unknown,
    label: unknown,
  ): Promise<void> {
    const target = await this.requireKnownTarget(repositoryRoot, filePath);
    if (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/u.test(sha)) {
      throw new Error("The selected revision is invalid.");
    }
    const canonicalSha = await resolveRef(target.repositoryRoot, sha);
    await this.compareTargetWithRevision(
      target,
      canonicalSha,
      typeof label === "string" && label.length > 0 ? label : canonicalSha.slice(0, 8),
    );
  }

  private async compareTargetWithRevision(
    target: FileContextTarget,
    sha: string,
    label: string,
  ): Promise<void> {
    const changes = await listWorkingTreeFileChanges(target.repositoryRoot, sha, target.filePath);
    const file =
      changes.find(
        (change) => change.newPath === target.filePath || change.oldPath === target.filePath,
      ) ?? defaultModifiedFile(target.filePath);
    await this.comparisonController.openFileDiff(
      {
        fromSha: sha,
        label: `${label} ↔ Working Tree`,
        repositoryRootPath: target.repositoryRoot,
        toSha: null,
      },
      file,
    );
    this.logger.info("Compared file with revision", { operation: "compareFileWithRevision" });
  }

  private async requireTarget(candidate?: unknown): Promise<FileContextTarget> {
    const target = await resolveFileContextTarget(candidate);
    if (!target) throw new Error("Select a file inside a Git repository first.");
    return target;
  }

  private async requireKnownTarget(
    repositoryRoot: unknown,
    filePath: unknown,
  ): Promise<FileContextTarget> {
    const target = await resolveKnownFileTarget(repositoryRoot, filePath);
    if (!target) throw new Error("The selected repository file is not available.");
    return target;
  }
}

function defaultModifiedFile(filePath: string): FileChange {
  return { newPath: filePath, status: "modified" };
}
