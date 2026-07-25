import * as vscode from "vscode";

import type { BlameController } from "../../application/BlameController";
import type { CommitDetailsController } from "../../application/CommitDetailsController";
import type { ComparisonController } from "../../application/ComparisonController";
import type { FileHistoryController } from "../../application/FileHistoryController";
import type { FileActionsController } from "../../application/FileActionsController";
import type { GitLabController } from "../../application/GitLabController";
import type { Logger } from "../../application/Logger";
import type { RepositoryNavigationController } from "../../application/RepositoryNavigationController";
import type { StashController } from "../../application/StashController";
import type { SavedComparisonV1 } from "../../domain/comparison";
import type { CommitInfo } from "../../domain/comparisonResult";
import type { FileNode } from "../tree/changeNodes";
import type { ComparisonTreeNode } from "../tree/ComparisonTreeProvider";
import type { FileHistoryNode } from "../tree/FileHistoryTreeProvider";
import type { BranchCommitNode, BranchNode, BranchesTreeNode } from "../tree/BranchesTreeProvider";
import type { DetailNode } from "../tree/CommitDetailsTreeProvider";
import type { StashNode, StashTreeNode } from "../tree/StashTreeProvider";
import type { WorktreeNode, WorktreesTreeNode } from "../tree/WorktreesTreeProvider";
import { COMMAND_IDS, type CommandId } from "./commandIds";

type CommandHandler = (...args: readonly unknown[]) => Promise<void> | void;

export function registerCommands(
  context: vscode.ExtensionContext,
  logger: Logger,
  controller: ComparisonController,
  repositoryNavigationController: RepositoryNavigationController,
  fileActionsController: FileActionsController,
  commitDetailsController: CommitDetailsController,
  fileHistoryController: FileHistoryController,
  stashController: StashController,
  blameController: BlameController,
  gitLabController: GitLabController,
): void {
  const handlers: Readonly<Record<CommandId, CommandHandler>> = {
    [COMMAND_IDS.changeComparisonFileFilter]: () => controller.changeComparisonFileFilter(),
    [COMMAND_IDS.changeComparisonFileSort]: () => controller.changeComparisonFileSort(),
    [COMMAND_IDS.changeComparisonMode]: (node) =>
      controller.changeComparisonMode(requireComparison(node)),
    [COMMAND_IDS.changeFileAnnotations]: (resource) =>
      fileActionsController.changeAnnotations(resource),
    [COMMAND_IDS.changeFileHistoryFilter]: () => fileHistoryController.changeFilter(),
    [COMMAND_IDS.changeStashFilter]: () => stashController.changeFilter(),
    [COMMAND_IDS.closeComparison]: (node) => controller.closeComparison(requireComparison(node)),
    [COMMAND_IDS.compareCommitWithParent]: (node) =>
      commitDetailsController.compareWithParent(requireCommitDetail(node)),
    [COMMAND_IDS.compareStashFileWithHead]: (node) =>
      fileActionsController.compareStashFileWithHead(node),
    [COMMAND_IDS.compareStashFileWithWorkingTree]: (node) =>
      fileActionsController.compareStashFileWithWorkingTree(node),
    [COMMAND_IDS.compareFileWithRevision]: (resource, sha, filePath, label) =>
      typeof resource === "string" && typeof sha === "string" && typeof filePath === "string"
        ? fileActionsController.compareFileWithRevisionAt(resource, sha, filePath, label)
        : fileActionsController.compareFileWithRevision(resource),
    [COMMAND_IDS.compareCurrentBranch]: () => controller.compareCurrentBranch(),
    [COMMAND_IDS.compareBranchWithCurrent]: (node) =>
      repositoryNavigationController.compareBranchWithCurrent(requireBranch(node)),
    [COMMAND_IDS.copyBranchName]: (node) =>
      repositoryNavigationController.copyBranchName(requireBranch(node)),
    [COMMAND_IDS.copyCommitMessage]: (node) => controller.copyCommitMessage(requireCommit(node)),
    [COMMAND_IDS.copyCommitSha]: (node) => controller.copyCommitSha(requireCommit(node)),
    [COMMAND_IDS.copyCommitDetail]: (node) =>
      commitDetailsController.copyDetail(requireCommitDetail(node)),
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
    [COMMAND_IDS.copyStashSha]: (node) => stashController.copyStashSha(requireStash(node).stash),
    [COMMAND_IDS.copyWorktreePath]: (node) =>
      repositoryNavigationController.copyWorktreePath(requireWorktree(node)),
    [COMMAND_IDS.findOtherStashesContainingFile]: (node) =>
      fileActionsController.findOtherStashesContainingFile(node),
    [COMMAND_IDS.markAllComparisonFilesReviewed]: (node) =>
      controller.setAllComparisonFilesReviewed(requireComparison(node), true),
    [COMMAND_IDS.markFileReviewed]: (node) =>
      controller.markFileReviewed(requireReviewFile(node), true),
    [COMMAND_IDS.markFileUnreviewed]: (node) =>
      controller.markFileReviewed(requireReviewFile(node), false),
    [COMMAND_IDS.newComparison]: () => controller.newComparison(),
    [COMMAND_IDS.nextUnreviewedFile]: (node) =>
      controller.openAdjacentUnreviewedFile("next", reviewNavigationCandidate(node)),
    [COMMAND_IDS.openChangedFileAtRevision]: (node) =>
      fileActionsController.openFileAtRevision(node),
    [COMMAND_IDS.openFile]: (node) => {
      const file = requireFile(node);
      return controller.openWorkingTreeFile(file.scope, file.file);
    },
    [COMMAND_IDS.openFileAtRevision]: (repositoryRootPath, sha, filePath) =>
      typeof repositoryRootPath === "string" &&
      typeof sha === "string" &&
      typeof filePath === "string"
        ? controller.openFileAtRevision(repositoryRootPath, sha, filePath)
        : fileActionsController.openFileAtRevision(repositoryRootPath),
    [COMMAND_IDS.openFileHistoryAtRevision]: (node) =>
      fileHistoryController.openFileAtRevision(requireFileHistoryNode(node)),
    [COMMAND_IDS.openFileHistoryDiff]: (node) =>
      fileHistoryController.openFileDiff(requireFileHistoryNode(node)),
    [COMMAND_IDS.openNextFileHistoryRevision]: (node) =>
      fileHistoryController.openAdjacent(requireFileHistoryNode(node), "next"),
    [COMMAND_IDS.openPreviousFileHistoryRevision]: (node) =>
      fileHistoryController.openAdjacent(requireFileHistoryNode(node), "previous"),
    [COMMAND_IDS.openCommitParentDetails]: (node) =>
      commitDetailsController.openParent(requireCommitDetail(node)),
    [COMMAND_IDS.openGitLabBranch]: (node) => {
      const branch = requireBranch(node);
      return gitLabController.openBranch(branch.repository.rootPath, branch.branch);
    },
    [COMMAND_IDS.openGitLabCommit]: (node) => {
      const selection = requireCommitSelection(node);
      return gitLabController.openCommit(selection.repositoryRoot, selection.commit);
    },
    [COMMAND_IDS.openGitLabComparison]: (node) =>
      gitLabController.openComparison(requireComparison(node)),
    [COMMAND_IDS.openGitLabFile]: (resource, sha, filePath, startLine, endLine) =>
      typeof resource === "string" && typeof sha === "string" && typeof filePath === "string"
        ? gitLabController.openFileAt(resource, sha, filePath, startLine, endLine)
        : gitLabController.openFile(resource),
    [COMMAND_IDS.openGitLabLocalReference]: (resource) =>
      gitLabController.openLocalReference(resource),
    [COMMAND_IDS.openGitLabProject]: (resource) => gitLabController.openProject(resource),
    [COMMAND_IDS.openGitLabReference]: (resource) => gitLabController.openReference(resource),
    [COMMAND_IDS.openLineDiff]: (scope, file) => fileActionsController.openLineDiff(scope, file),
    [COMMAND_IDS.openStashFileAtRevision]: (node) => fileActionsController.openFileAtRevision(node),
    [COMMAND_IDS.openFileDiff]: (scope, file) =>
      controller.openFileDiff(
        scope as Parameters<ComparisonController["openFileDiff"]>[0],
        file as Parameters<ComparisonController["openFileDiff"]>[1],
      ),
    [COMMAND_IDS.openWorktree]: (node) =>
      repositoryNavigationController.openWorktree(requireWorktree(node)),
    [COMMAND_IDS.pinComparison]: (node) => controller.setPinned(requireComparison(node), true),
    [COMMAND_IDS.previousUnreviewedFile]: (node) =>
      controller.openAdjacentUnreviewedFile("previous", reviewNavigationCandidate(node)),
    [COMMAND_IDS.quickOpenComparisonFile]: (node) =>
      controller.quickOpenComparisonFile(optionalComparison(node)),
    [COMMAND_IDS.refreshAll]: () => {
      controller.refreshAll();
    },
    [COMMAND_IDS.refreshComparison]: (node) => {
      controller.refreshComparison(requireComparison(node));
    },
    [COMMAND_IDS.refreshFileHistory]: () => fileHistoryController.refresh(true),
    [COMMAND_IDS.refreshRepositoryNavigation]: () => repositoryNavigationController.refresh(),
    [COMMAND_IDS.refreshStashes]: () => stashController.refresh(),
    [COMMAND_IDS.resetComparisonReview]: (node) =>
      controller.setAllComparisonFilesReviewed(requireComparison(node), false),
    [COMMAND_IDS.searchCommits]: () => commitDetailsController.search(),
    [COMMAND_IDS.showCommitDetails]: (node) => {
      const selection = requireCommitSelection(node);
      return commitDetailsController.show(selection.repositoryRoot, selection.commit);
    },
    [COMMAND_IDS.showStashCommitDetails]: (node) => {
      const selection = requireStash(node);
      return commitDetailsController.show(selection.repository.rootPath, {
        authorDate: selection.stash.authorDate,
        authorName: "stash",
        sha: selection.stash.sha,
        subject: selection.stash.message,
      });
    },
    [COMMAND_IDS.showFileHistory]: (resource, filePath) =>
      typeof resource === "string" && typeof filePath === "string"
        ? fileActionsController.showFileHistoryAt(resource, filePath)
        : fileActionsController.showFileHistory(resource),
    [COMMAND_IDS.showLineBlameActions]: () => blameController.showLineBlameActions(),
    [COMMAND_IDS.showLineHistory]: (resource, filePath, lineNumber) =>
      typeof resource === "string" && typeof filePath === "string"
        ? fileActionsController.showLineHistoryAt(resource, filePath, lineNumber)
        : fileActionsController.showLineHistory(resource),
    [COMMAND_IDS.showRefHavenMenu]: (resource) => fileActionsController.showMenu(resource),
    [COMMAND_IDS.stashFile]: (resource) => fileActionsController.stashFile(resource),
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
          error instanceof Error ? error.message : "RefHaven command failed.",
        );
      }
    });

    context.subscriptions.push(disposable);
  }
}

function requireBranch(node: unknown): BranchNode {
  const candidate = node as Partial<BranchesTreeNode> | undefined;
  if (candidate?.kind === "branch" && candidate.branch && candidate.repository) {
    return candidate as BranchNode;
  }
  throw new Error("Select a branch in the Branches view first.");
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
  const historyCandidate = node as Partial<FileHistoryNode> | undefined;
  if (historyCandidate?.kind === "fileHistoryCommit" && historyCandidate.entry !== undefined) {
    return historyCandidate.entry.commit;
  }
  const branchCandidate = node as Partial<BranchCommitNode> | undefined;
  if (branchCandidate?.kind === "branchCommit" && branchCandidate.commit !== undefined) {
    return branchCandidate.commit;
  }
  throw new Error("Select a commit in the Branch Comparisons view first.");
}

function requireCommitSelection(node: unknown): {
  readonly commit: CommitInfo;
  readonly repositoryRoot: string;
} {
  const comparisonNode = node as Partial<ComparisonTreeNode> | undefined;
  if (
    comparisonNode?.kind === "commit" &&
    comparisonNode.commit !== undefined &&
    comparisonNode.repositoryRoot !== undefined
  ) {
    return { commit: comparisonNode.commit, repositoryRoot: comparisonNode.repositoryRoot };
  }
  const historyNode = node as Partial<FileHistoryNode> | undefined;
  if (
    historyNode?.kind === "fileHistoryCommit" &&
    historyNode.entry !== undefined &&
    historyNode.target !== undefined
  ) {
    return { commit: historyNode.entry.commit, repositoryRoot: historyNode.target.repositoryRoot };
  }
  const branchNode = node as Partial<BranchCommitNode> | undefined;
  if (
    branchNode?.kind === "branchCommit" &&
    branchNode.commit !== undefined &&
    branchNode.repositoryRoot !== undefined
  ) {
    return { commit: branchNode.commit, repositoryRoot: branchNode.repositoryRoot };
  }
  throw new Error("Select a commit in a RefHaven view first.");
}

function requireFileHistoryNode(node: unknown): FileHistoryNode {
  const candidate = node as Partial<FileHistoryNode> | undefined;
  if (
    candidate?.kind === "fileHistoryCommit" &&
    candidate.entry !== undefined &&
    candidate.target !== undefined
  ) {
    return candidate as FileHistoryNode;
  }
  throw new Error("Select a commit in the File History view first.");
}

function requireCommitDetail(node: unknown): DetailNode {
  const candidate = node as Partial<DetailNode> | undefined;
  if (
    candidate?.kind === "detail" &&
    candidate.commitSha !== undefined &&
    candidate.copyValue !== undefined &&
    candidate.repositoryRoot !== undefined
  ) {
    return candidate as DetailNode;
  }
  throw new Error("Select a metadata row in Commit Details first.");
}

function requireFile(node: unknown): FileNode {
  const candidate = node as Partial<FileNode> | undefined;
  if (candidate?.kind === "file" && candidate.file !== undefined && candidate.scope !== undefined) {
    return candidate as FileNode;
  }
  throw new Error("Select a changed file in a RefHaven view first.");
}

function requireReviewFile(node: unknown): FileNode {
  const file = requireFile(node);
  if (!file.review) throw new Error("Select a file from a saved comparison first.");
  return file;
}

function optionalComparison(node: unknown): SavedComparisonV1 | undefined {
  const candidate = node as Partial<ComparisonTreeNode> | undefined;
  return candidate?.kind === "comparison" ? candidate.comparison : undefined;
}

function reviewNavigationCandidate(node: unknown): FileNode | SavedComparisonV1 | undefined {
  const candidate = node as Partial<ComparisonTreeNode> | undefined;
  if (candidate?.kind === "comparison" && candidate.comparison) return candidate.comparison;
  if (candidate?.kind === "file" && candidate.file && candidate.scope && candidate.review) {
    return candidate as FileNode;
  }
  return undefined;
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

function requireWorktree(node: unknown): WorktreeNode {
  const candidate = node as Partial<WorktreesTreeNode> | undefined;
  if (candidate?.kind === "worktree" && candidate.worktree && candidate.repository) {
    return candidate as WorktreeNode;
  }
  throw new Error("Select a worktree in the Worktrees view first.");
}
