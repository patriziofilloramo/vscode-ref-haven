import * as vscode from "vscode";

import { isGitObjectId } from "../domain/gitObjectId";
import { MAX_STASH_MESSAGE_LENGTH } from "../domain/inputLimits";
import type { FileChange } from "../domain/comparisonResult";
import type { FileDiffScope } from "../domain/fileDiffScope";
import {
  listChangedFilesForPath,
  listComparisonRefs,
  listStashes,
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
import type { FileNode } from "../ui/tree/changeNodes";
import type { ComparisonController } from "./ComparisonController";
import type { FileAnnotationsController } from "./FileAnnotationsController";
import type { FileHistoryController } from "./FileHistoryController";
import type { Logger } from "./Logger";
import type { StashController } from "./StashController";

const MAX_SEARCHED_STASHES = 50;

interface FileActionItem extends vscode.QuickPickItem {
  readonly run: () => Thenable<unknown>;
}

type StashFileNode = FileNode & {
  readonly scope: FileDiffScope & {
    readonly fromSha: string;
    readonly toSha: string;
  };
};

export class FileActionsController {
  public constructor(
    private readonly comparisonController: ComparisonController,
    private readonly fileAnnotationsController: FileAnnotationsController,
    private readonly fileHistoryController: FileHistoryController,
    private readonly stashController: StashController,
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
          detail: "Select the matching change in a saved branch comparison",
          label: "$(reveal-in-explorer) Reveal File in Branch Comparison",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.revealFileInComparison, target.uri),
        },
        {
          detail: "Tracked staged and unstaged changes for this file only",
          label: "$(git-stash) Stash This File...",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.stashFile, commandArgument),
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
        {
          detail: "Open this file at the local HEAD revision on an approved origin",
          label: "$(git-pull-request) Open File in Browser",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.openGitLabFile, target.uri),
        },
        {
          detail: "Copy a locally validated URL without opening a browser",
          label: "$(copy) Copy File URL",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.copyGitLabFileUrl, target.uri),
        },
        {
          detail: "Open #issue or !merge-request on the approved project",
          label: "$(link-external) Open Issue or Merge Request in Browser...",
          run: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.openGitLabReference, target.uri),
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

  public async revealFileInComparison(candidate?: unknown): Promise<void> {
    const target = await this.requireTarget(candidate);
    await this.comparisonController.revealFileInComparison(target.repositoryRoot, target.filePath);
  }

  public async stashFile(candidate?: unknown): Promise<void> {
    const selectedTarget = await this.requireTarget(candidate);
    const message = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "Stash message",
      prompt:
        "Stash tracked staged and unstaged changes for this file only. Untracked files are excluded.",
      title: "RefHaven: Stash This File",
      value: `RefHaven: ${selectedTarget.filePath}`,
      validateInput: (value) => {
        const length = value.trim().length;
        return length === 0 || length > MAX_STASH_MESSAGE_LENGTH
          ? `Enter a stash message between 1 and ${MAX_STASH_MESSAGE_LENGTH.toString()} characters.`
          : undefined;
      },
    });
    if (message === undefined) return;

    const target = await this.requireTarget(candidate);
    if (
      target.repositoryRoot !== selectedTarget.repositoryRoot ||
      target.filePath !== selectedTarget.filePath
    ) {
      throw new Error("The selected file changed while preparing the stash.");
    }
    await this.stashController.stashFile(target.repositoryRoot, target.filePath, message);
  }

  public async compareStashFileWithHead(candidate: unknown): Promise<void> {
    const node = await this.requireStashFileNode(candidate);
    const headSha = await resolveRef(node.scope.repositoryRootPath, "HEAD");
    const stashSha = await resolveRef(node.scope.repositoryRootPath, node.scope.toSha);
    const file = await this.loadRevisionFileChange(
      node.scope.repositoryRootPath,
      headSha,
      stashSha,
      node.file,
    );
    await this.comparisonController.openFileDiff(
      {
        fromSha: headSha,
        label: `HEAD ↔ ${node.scope.label}`,
        repositoryRootPath: node.scope.repositoryRootPath,
        toSha: stashSha,
      },
      file,
    );
  }

  public async compareStashFileWithWorkingTree(candidate: unknown): Promise<void> {
    const node = await this.requireStashFileNode(candidate);
    const stashSha = await resolveRef(node.scope.repositoryRootPath, node.scope.toSha);
    const paths = stashFilePaths(node.file);
    let file: FileChange | undefined;
    for (const filePath of paths) {
      const changes = await listWorkingTreeFileChanges(
        node.scope.repositoryRootPath,
        stashSha,
        filePath,
      );
      file = findMatchingFile(changes, paths);
      if (file) break;
    }
    await this.comparisonController.openFileDiff(
      {
        fromSha: stashSha,
        label: `${node.scope.label} ↔ Working Tree`,
        repositoryRootPath: node.scope.repositoryRootPath,
        toSha: null,
      },
      file ?? defaultModifiedFile(node.file.newPath),
    );
  }

  public async findOtherStashesContainingFile(candidate: unknown): Promise<void> {
    const node = await this.requireStashFileNode(candidate);
    const otherStashes = (await listStashes(node.scope.repositoryRootPath)).filter(
      ({ sha }) => sha !== node.scope.toSha,
    );
    const stashes = otherStashes.slice(0, MAX_SEARCHED_STASHES);
    // The search runs two Git diffs per stash, so it is capped; say so
    // instead of implying every stash was searched.
    const searchScope =
      otherStashes.length > stashes.length
        ? `the ${stashes.length.toString()} most recent of ${otherStashes.length.toString()} stashes`
        : "recent stashes";
    const paths = stashFilePaths(node.file);
    const matches = await vscode.window.withProgress(
      {
        cancellable: true,
        location: vscode.ProgressLocation.Notification,
        title: `RefHaven: Searching ${searchScope} for ${node.file.newPath}`,
      },
      async (_progress, token) => {
        const abortController = new AbortController();
        const cancellation = token.onCancellationRequested(() => abortController.abort());
        try {
          const results = await Promise.all(
            stashes.map(async (stash) => {
              for (const filePath of paths) {
                const changes = await listChangedFilesForPath(
                  node.scope.repositoryRootPath,
                  stash.parentSha,
                  stash.sha,
                  filePath,
                  abortController.signal,
                );
                const file = findMatchingFile(changes, paths);
                if (file) return { file, stash };
              }
              return null;
            }),
          );
          return results.filter(
            (match): match is NonNullable<(typeof results)[number]> => match !== null,
          );
        } catch (error) {
          if (token.isCancellationRequested) return null;
          throw error;
        } finally {
          cancellation.dispose();
        }
      },
    );
    if (matches === null) return;
    if (matches.length === 0) {
      void vscode.window.showInformationMessage(
        `None of ${searchScope} contains ${node.file.newPath}.`,
      );
      return;
    }
    const selected = await vscode.window.showQuickPick(
      matches.map((match) => ({
        description: match.stash.selector,
        detail: match.stash.branchName
          ? `${match.stash.branchName} · ${new Date(match.stash.authorDate).toLocaleString()}`
          : new Date(match.stash.authorDate).toLocaleString(),
        label: match.stash.message,
        match,
      })),
      {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: node.file.newPath,
        title: "RefHaven: Other Stashes Containing File",
      },
    );
    if (!selected) return;
    await this.comparisonController.openFileDiff(
      {
        fromSha: selected.match.stash.parentSha,
        label: selected.match.stash.selector,
        repositoryRootPath: node.scope.repositoryRootPath,
        toSha: selected.match.stash.sha,
      },
      selected.match.file,
    );
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
    if (!isGitObjectId(sha)) {
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

  private async loadRevisionFileChange(
    repositoryRoot: string,
    fromSha: string,
    toSha: string,
    selectedFile: FileChange,
  ): Promise<FileChange> {
    const paths = stashFilePaths(selectedFile);
    for (const filePath of paths) {
      const changes = await listChangedFilesForPath(repositoryRoot, fromSha, toSha, filePath);
      const file = findMatchingFile(changes, paths);
      if (file) return file;
    }
    return defaultModifiedFile(selectedFile.newPath);
  }

  private async requireStashFileNode(candidate: unknown): Promise<StashFileNode> {
    const node = asFileNode(candidate);
    if (!node?.scope.fromSha || !node.scope.toSha || !/^stash@\{\d+\}$/u.test(node.scope.label)) {
      throw new Error("Select a changed file in the Stashes view first.");
    }
    await this.requireKnownTarget(node.scope.repositoryRootPath, node.file.newPath);
    return node as StashFileNode;
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

function stashFilePaths(file: FileChange): readonly string[] {
  return file.oldPath && file.oldPath !== file.newPath
    ? [file.newPath, file.oldPath]
    : [file.newPath];
}

function findMatchingFile(
  changes: readonly FileChange[],
  filePaths: readonly string[],
): FileChange | undefined {
  const paths = new Set(filePaths);
  return changes.find(
    ({ newPath, oldPath }) => paths.has(newPath) || (oldPath && paths.has(oldPath)),
  );
}
