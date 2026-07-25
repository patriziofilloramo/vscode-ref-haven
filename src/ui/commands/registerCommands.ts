import * as vscode from "vscode";

import type { BlameController } from "../../application/BlameController";
import type { ComparisonController } from "../../application/ComparisonController";
import type { Logger } from "../../application/Logger";
import type { StashController } from "../../application/StashController";
import type { SavedComparisonV1 } from "../../domain/comparison";
import type { CommitInfo } from "../../domain/comparisonResult";
import type { FileNode } from "../tree/changeNodes";
import type { ComparisonTreeNode } from "../tree/ComparisonTreeProvider";
import type { StashNode, StashTreeNode } from "../tree/StashTreeProvider";
import { COMMAND_IDS, type CommandId } from "./commandIds";

type CommandHandler = (...args: readonly unknown[]) => Promise<void> | void;

export function registerCommands(
  context: vscode.ExtensionContext,
  logger: Logger,
  controller: ComparisonController,
  stashController: StashController,
  blameController: BlameController,
): void {
  const handlers: Readonly<Record<CommandId, CommandHandler>> = {
    [COMMAND_IDS.closeComparison]: (node) => controller.closeComparison(requireComparison(node)),
    [COMMAND_IDS.compareCurrentBranch]: () => controller.compareCurrentBranch(),
    [COMMAND_IDS.copyCommitMessage]: (node) => controller.copyCommitMessage(requireCommit(node)),
    [COMMAND_IDS.copyCommitSha]: (node) => controller.copyCommitSha(requireCommit(node)),
    [COMMAND_IDS.copyComparisonSummary]: (node) =>
      controller.copyComparisonSummary(requireComparison(node)),
    [COMMAND_IDS.copyFilePath]: (node) => {
      const file = requireFile(node);
      return controller.copyFilePath(file.scope, file.file);
    },
    [COMMAND_IDS.copyRelativeFilePath]: (node) => {
      const file = requireFile(node);
      return controller.copyRelativeFilePath(file.scope, file.file);
    },
    [COMMAND_IDS.copyStashMessage]: (node) =>
      stashController.copyStashMessage(requireStash(node).stash),
    [COMMAND_IDS.newComparison]: () => controller.newComparison(),
    [COMMAND_IDS.openFile]: (node) => {
      const file = requireFile(node);
      return controller.openWorkingTreeFile(file.scope, file.file);
    },
    [COMMAND_IDS.openFileAtRevision]: (repositoryRootPath, sha, filePath) =>
      controller.openFileAtRevision(repositoryRootPath, sha, filePath),
    [COMMAND_IDS.openFileDiff]: (scope, file) =>
      controller.openFileDiff(
        scope as Parameters<ComparisonController["openFileDiff"]>[0],
        file as Parameters<ComparisonController["openFileDiff"]>[1],
      ),
    [COMMAND_IDS.pinComparison]: (node) => controller.setPinned(requireComparison(node), true),
    [COMMAND_IDS.refreshAll]: () => {
      controller.refreshAll();
    },
    [COMMAND_IDS.refreshComparison]: (node) => {
      controller.refreshComparison(requireComparison(node));
    },
    [COMMAND_IDS.refreshStashes]: () => stashController.refresh(),
    [COMMAND_IDS.showLineBlameActions]: () => blameController.showLineBlameActions(),
    [COMMAND_IDS.swapComparison]: (node) => controller.swapComparison(requireComparison(node)),
    [COMMAND_IDS.toggleInlineBlame]: () => blameController.toggleInlineBlame(),
    [COMMAND_IDS.unpinComparison]: (node) => controller.setPinned(requireComparison(node), false),
    [COMMAND_IDS.viewFilesAsList]: () => controller.setFilesLayout("list"),
    [COMMAND_IDS.viewFilesAsTree]: () => controller.setFilesLayout("tree"),
  };

  for (const [commandId, handler] of Object.entries(handlers)) {
    const disposable = vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
      logger.info("Command invoked", { operation: commandId });
      try {
        await handler(...args);
      } catch (error) {
        logger.error("Command failed", {
          message: error instanceof Error ? error.message : String(error),
          operation: commandId,
        });
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "Branch Compare command failed.",
        );
      }
    });

    context.subscriptions.push(disposable);
  }
}

function requireComparison(node: unknown): SavedComparisonV1 {
  const candidate = node as Partial<ComparisonTreeNode> | undefined;
  if (candidate?.kind === "comparison" && candidate.comparison !== undefined) {
    return candidate.comparison;
  }
  throw new Error("Select a comparison in the Branch Comparisons view first.");
}

function requireCommit(node: unknown): CommitInfo {
  const candidate = node as Partial<ComparisonTreeNode> | undefined;
  if (candidate?.kind === "commit" && candidate.commit !== undefined) return candidate.commit;
  throw new Error("Select a commit in the Branch Comparisons view first.");
}

function requireFile(node: unknown): FileNode {
  const candidate = node as Partial<FileNode> | undefined;
  if (candidate?.kind === "file" && candidate.file !== undefined && candidate.scope !== undefined) {
    return candidate as FileNode;
  }
  throw new Error("Select a changed file in a Branch Compare view first.");
}

function requireStash(node: unknown): StashNode {
  const candidate = node as Partial<StashTreeNode> | undefined;
  if (
    candidate?.kind === "stash" &&
    candidate.repository !== undefined &&
    candidate.stash !== undefined
  ) {
    return candidate as StashNode;
  }
  throw new Error("Select a stash in the Stashes view first.");
}
