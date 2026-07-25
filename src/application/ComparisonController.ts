import { randomUUID } from "node:crypto";
import { join } from "node:path";

import * as vscode from "vscode";

import type { Logger } from "./Logger";
import { calculateComparison } from "./ComparisonEngine";
import type { ComparisonStore } from "./ComparisonStore";
import {
  comparisonLabel,
  hasSameComparisonIdentity,
  withPinned,
  withSwappedRefs,
  type SavedComparisonV1,
} from "../domain/comparison";
import {
  shortSha,
  sumDiffTotals,
  type CommitInfo,
  type ComparisonResult,
  type FileChange,
} from "../domain/comparisonResult";
import type { FileDiffScope } from "../domain/fileDiffScope";
import { formatDiffStats, pluralize } from "../ui/format";
import { isFileChange, isFileDiffScope } from "../domain/validation";
import {
  listBranchRefs,
  discoverRepositories,
  readCurrentBranch,
} from "../infrastructure/git/GitCli";
import { pickBranch, pickRepository } from "../ui/pickers/comparisonPickers";
import type { ComparisonTreeProvider, FilesLayout } from "../ui/tree/ComparisonTreeProvider";
import {
  BinaryRevisionError,
  type GitRevisionContentProvider,
} from "../ui/documents/GitRevisionContentProvider";

const FILES_LAYOUT_STORAGE_KEY = "branchCompare.view.filesLayout";
const FILES_LAYOUT_CONTEXT_KEY = "branchCompare.filesLayout";

export class ComparisonController {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ComparisonStore,
    private readonly treeProvider: ComparisonTreeProvider,
    private readonly logger: Logger,
    private readonly revisionProvider: GitRevisionContentProvider,
  ) {}

  public initialize(): void {
    const layout = this.context.workspaceState.get<unknown>(FILES_LAYOUT_STORAGE_KEY, "tree");
    this.applyFilesLayout(layout === "list" ? "list" : "tree");
    this.treeProvider.setComparisons(this.store.getAll());
  }

  public async newComparison(): Promise<void> {
    await this.createComparison({ useCurrentBranchAsTarget: false });
  }

  public async compareCurrentBranch(): Promise<void> {
    await this.createComparison({ useCurrentBranchAsTarget: true });
  }

  public refreshAll(): void {
    const comparisons = this.store.getAll();
    this.treeProvider.invalidateAllResults();
    this.treeProvider.setComparisons(comparisons);
    this.logger.info("Refreshed saved comparisons", {
      count: comparisons.length,
      operation: "refreshAll",
    });
  }

  public refreshComparison(comparison: SavedComparisonV1): void {
    this.treeProvider.invalidateResult(comparison.id);
    this.logger.info("Refreshed comparison", { operation: "refreshComparison" });
  }

  public async swapComparison(comparison: SavedComparisonV1): Promise<void> {
    const swapped = withSwappedRefs(comparison, Date.now());
    const duplicate = this.store
      .getAll()
      .find(
        (candidate) =>
          candidate.id !== comparison.id && hasSameComparisonIdentity(candidate, swapped),
      );
    if (duplicate) {
      void vscode.window.showInformationMessage(
        `A comparison for ${comparisonLabel(swapped)} already exists.`,
      );
      return;
    }
    const comparisons = await this.store.replace(comparison.id, () => swapped);
    this.treeProvider.invalidateResult(comparison.id);
    this.treeProvider.setComparisons(comparisons);
    this.logger.info("Swapped comparison direction", { operation: "swapComparison" });
  }

  public async setPinned(comparison: SavedComparisonV1, pinned: boolean): Promise<void> {
    const comparisons = await this.store.replace(comparison.id, (current) =>
      withPinned(current, pinned, Date.now()),
    );
    this.treeProvider.setComparisons(comparisons);
    this.logger.info(pinned ? "Pinned comparison" : "Unpinned comparison", {
      operation: "setPinned",
    });
  }

  public async closeComparison(comparison: SavedComparisonV1): Promise<void> {
    const comparisons = await this.store.remove(comparison.id);
    this.treeProvider.setComparisons(comparisons);
    this.logger.info("Closed comparison", { operation: "closeComparison" });
  }

  public async copyComparisonSummary(comparison: SavedComparisonV1): Promise<void> {
    let summary = `${comparisonLabel(comparison)} (${comparison.repository.label})`;
    try {
      const result = await this.calculateComparison(comparison);
      const totals = sumDiffTotals(result.files);
      summary = [
        summary,
        `ahead ${pluralize(result.aheadCount, "commit")}, behind ${pluralize(result.behindCount, "commit")}`,
        `${pluralize(result.files.length, "changed file")}, ${formatDiffStats(totals.additions, totals.deletions)}`,
        `base ${shortSha(result.baseSha)}, target ${shortSha(result.targetSha)}`,
      ].join("\n");
    } catch {
      // Copy the configuration line alone when Git cannot compute a result.
    }
    await vscode.env.clipboard.writeText(summary);
    void vscode.window.showInformationMessage("Comparison summary copied to the clipboard.");
  }

  public async copyCommitSha(commit: CommitInfo): Promise<void> {
    await vscode.env.clipboard.writeText(commit.sha);
    void vscode.window.showInformationMessage(`Copied ${shortSha(commit.sha)} to the clipboard.`);
  }

  public async copyCommitMessage(commit: CommitInfo): Promise<void> {
    await vscode.env.clipboard.writeText(commit.subject);
    void vscode.window.showInformationMessage("Commit message copied to the clipboard.");
  }

  public async openWorkingTreeFile(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("Branch Compare file selection is invalid.");
    }
    if (file.status === "deleted") {
      void vscode.window.showInformationMessage(`${file.newPath} was deleted in this comparison.`);
      return;
    }

    const uri = vscode.Uri.file(join(scope.repositoryRootPath, file.newPath));
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      void vscode.window.showInformationMessage(
        `${file.newPath} does not exist in the working tree.`,
      );
      return;
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  }

  public async copyFilePath(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("Branch Compare file selection is invalid.");
    }
    await vscode.env.clipboard.writeText(join(scope.repositoryRootPath, file.newPath));
    void vscode.window.showInformationMessage("File path copied to the clipboard.");
  }

  public async copyRelativeFilePath(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("Branch Compare file selection is invalid.");
    }
    await vscode.env.clipboard.writeText(file.newPath);
    void vscode.window.showInformationMessage("Relative file path copied to the clipboard.");
  }

  public async setFilesLayout(layout: FilesLayout): Promise<void> {
    this.applyFilesLayout(layout);
    await this.context.workspaceState.update(FILES_LAYOUT_STORAGE_KEY, layout);
  }

  public calculateComparison(comparison: SavedComparisonV1): Promise<ComparisonResult> {
    this.logger.info("Calculating comparison", {
      mode: comparison.mode,
      operation: "calculateComparison",
    });
    return calculateComparison(comparison);
  }

  public async openFileDiff(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("Branch Compare file selection is invalid.");
    }

    const repositoryRoot = scope.repositoryRootPath;
    const oldPath = file.oldPath ?? file.newPath;
    const left =
      file.status === "added" || scope.fromSha === null
        ? this.revisionProvider.createEmptyUri(file.newPath)
        : this.revisionProvider.createRevisionUri(repositoryRoot, scope.fromSha, oldPath);
    const right =
      file.status === "deleted"
        ? this.revisionProvider.createEmptyUri(file.newPath)
        : this.revisionProvider.createRevisionUri(repositoryRoot, scope.toSha, file.newPath);

    try {
      await this.revisionProvider.prepareTextDiff(left, right);
    } catch (error) {
      if (error instanceof BinaryRevisionError) {
        void vscode.window.showInformationMessage(`Binary file changed: ${file.newPath}`);
        return;
      }
      throw error;
    }

    const title = `${file.newPath} (${scope.label})`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
  }

  private applyFilesLayout(layout: FilesLayout): void {
    this.treeProvider.setFilesLayout(layout);
    void vscode.commands.executeCommand("setContext", FILES_LAYOUT_CONTEXT_KEY, layout);
  }

  private async createComparison(options: {
    readonly useCurrentBranchAsTarget: boolean;
  }): Promise<void> {
    const repositories = await discoverRepositories();
    if (repositories.length === 0) {
      void vscode.window.showWarningMessage("Open a Git workspace before creating a comparison.");
      return;
    }
    const repository = await pickRepository(repositories);
    if (!repository) return;

    const branches = await listBranchRefs(repository.rootPath);
    if (branches.length < 2) {
      void vscode.window.showWarningMessage(
        "Branch Compare needs at least two local or remote branches.",
      );
      return;
    }

    const currentBranchName = await readCurrentBranch(repository.rootPath);
    const currentBranch = currentBranchName
      ? branches.find((branch) => branch.displayName === currentBranchName)
      : undefined;

    const targetRef = options.useCurrentBranchAsTarget
      ? currentBranch
      : await pickBranch(branches, "Select the branch to analyse", currentBranchName);
    if (!targetRef) {
      if (options.useCurrentBranchAsTarget) {
        void vscode.window.showWarningMessage(
          "The current repository is detached or its current branch is unavailable.",
        );
      }
      return;
    }

    const baseRef = await pickBranch(
      branches.filter((branch) => branch.fullName !== targetRef.fullName),
      `Select the base branch for ${targetRef.displayName}`,
    );
    if (!baseRef) return;

    const mode = "branchChanges" as const;
    const existingComparison = this.store.findByIdentity({ baseRef, mode, repository, targetRef });
    if (existingComparison) {
      this.logger.info("Skipped duplicate comparison", { mode, operation: "newComparison" });
      void vscode.window.showInformationMessage(
        `Comparison already exists: ${targetRef.displayName} relative to ${baseRef.displayName}.`,
      );
      return;
    }

    const now = Date.now();
    const comparison: SavedComparisonV1 = {
      baseRef,
      createdAt: now,
      id: randomUUID(),
      mode,
      order: this.store.nextOrder(),
      pinned: false,
      repository,
      schemaVersion: 1,
      targetRef,
      updatedAt: now,
    };

    const comparisons = await this.store.add(comparison);
    this.treeProvider.setComparisons(comparisons);
    this.logger.info("Created comparison", { mode: comparison.mode, operation: "newComparison" });
  }
}
