import { randomUUID } from "node:crypto";
import { dirname, relative } from "node:path";

import * as vscode from "vscode";

import type { Logger } from "./Logger";
import { calculateComparison } from "./ComparisonEngine";
import type { ComparisonStore } from "./ComparisonStore";
import {
  comparisonLabel,
  hasSameComparisonIdentity,
  withMode,
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
import { pathIdentityKey, resolvePathWithinRepository } from "../domain/pathValidation";
import { formatDiffStats, pluralize } from "../ui/format";
import { isFileChange, isFileDiffScope } from "../domain/validation";
import {
  findRepositoryRoot,
  listBranchRefs,
  discoverRepositories,
  readCurrentBranch,
  resolveRef,
} from "../infrastructure/git/GitCli";
import { pickBranch, pickRepository } from "../ui/pickers/comparisonPickers";
import {
  COMPARISON_VIEW_FOCUS_COMMAND,
  type ComparisonTreeNode,
  type ComparisonTreeProvider,
  type FilesLayout,
} from "../ui/tree/ComparisonTreeProvider";
import {
  BinaryRevisionError,
  type GitRevisionContentProvider,
} from "../ui/documents/GitRevisionContentProvider";

const FILES_LAYOUT_STORAGE_KEY = "refhaven.view.filesLayout";
const FILES_LAYOUT_CONTEXT_KEY = "refhaven.filesLayout";

export class ComparisonController {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ComparisonStore,
    private readonly treeProvider: ComparisonTreeProvider,
    private readonly treeView: vscode.TreeView<ComparisonTreeNode>,
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

  /**
   * Switches between branch-changes (merge base → target) and tip-to-tip
   * (base → target) diffs. Tip-to-tip shows the full difference even when the
   * target has no commits of its own, which branch-changes renders as empty.
   */
  public async changeComparisonMode(comparison: SavedComparisonV1): Promise<void> {
    const currentSuffix = { description: "current mode" };
    const selected = await vscode.window.showQuickPick(
      [
        {
          detail: "Only the changes the target branch made since the merge base.",
          label: "$(git-merge) Branch changes (three-dot)",
          mode: "branchChanges" as const,
          ...(comparison.mode === "branchChanges" ? currentSuffix : {}),
        },
        {
          detail: "Every difference between the two branch tips, in both directions.",
          label: "$(git-compare) Tip to tip (two-dot)",
          mode: "tipToTip" as const,
          ...(comparison.mode === "tipToTip" ? currentSuffix : {}),
        },
      ],
      {
        placeHolder: `Select how ${comparisonLabel(comparison)} diffs its files`,
        title: "RefHaven: Comparison Mode",
      },
    );
    if (!selected || selected.mode === comparison.mode) return;

    const updated = withMode(comparison, selected.mode, Date.now());
    const duplicate = this.store
      .getAll()
      .find(
        (candidate) =>
          candidate.id !== comparison.id && hasSameComparisonIdentity(candidate, updated),
      );
    if (duplicate) {
      void vscode.window.showInformationMessage(
        `A ${selected.mode === "tipToTip" ? "tip-to-tip" : "branch-changes"} comparison for ${comparisonLabel(updated)} already exists.`,
      );
      return;
    }
    const comparisons = await this.store.replace(comparison.id, () => updated);
    this.treeProvider.invalidateResult(comparison.id);
    this.treeProvider.setComparisons(comparisons);
    this.logger.info("Changed comparison mode", {
      mode: selected.mode,
      operation: "changeComparisonMode",
    });
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
      throw new Error("RefHaven file selection is invalid.");
    }
    if (file.status === "deleted") {
      void vscode.window.showInformationMessage(`${file.newPath} was deleted in this comparison.`);
      return;
    }

    const uri = vscode.Uri.file(
      resolvePathWithinRepository(scope.repositoryRootPath, file.newPath),
    );
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
      throw new Error("RefHaven file selection is invalid.");
    }
    await vscode.env.clipboard.writeText(
      resolvePathWithinRepository(scope.repositoryRootPath, file.newPath),
    );
    void vscode.window.showInformationMessage("File path copied to the clipboard.");
  }

  public async copyRelativeFilePath(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("RefHaven file selection is invalid.");
    }
    await vscode.env.clipboard.writeText(file.newPath);
    void vscode.window.showInformationMessage("Relative file path copied to the clipboard.");
  }

  /**
   * Opens a readonly view of a file at a revision. With all three arguments
   * (e.g. from a blame hover link) it opens directly; without them it prompts
   * for a branch revision of the active editor's file.
   */
  public async openFileAtRevision(
    repositoryRootPath?: unknown,
    sha?: unknown,
    filePath?: unknown,
  ): Promise<void> {
    if (
      typeof repositoryRootPath === "string" &&
      typeof sha === "string" &&
      typeof filePath === "string"
    ) {
      await this.assertKnownRepositoryRoot(repositoryRootPath);
      const uri = this.revisionProvider.createRevisionUri(repositoryRootPath, sha, filePath);
      await vscode.window.showTextDocument(uri, { preview: true });
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Open a file before opening one of its revisions.");
      return;
    }
    const fsPath = editor.document.uri.fsPath;
    const repositoryRoot = await findRepositoryRoot(dirname(fsPath));
    if (!repositoryRoot) {
      void vscode.window.showWarningMessage("The active file is not inside a Git repository.");
      return;
    }
    const relativePath = relative(repositoryRoot, fsPath).replaceAll("\\", "/");

    const branches = await listBranchRefs(repositoryRoot);
    if (branches.length === 0) {
      void vscode.window.showWarningMessage("This repository has no branches to open from.");
      return;
    }
    const currentBranchName = await readCurrentBranch(repositoryRoot);
    const ref = await pickBranch(
      branches,
      `Select the revision of ${relativePath} to open`,
      currentBranchName,
    );
    if (!ref) return;

    const revisionSha = await resolveRef(repositoryRoot, ref.fullName);
    const uri = this.revisionProvider.createRevisionUri(repositoryRoot, revisionSha, relativePath);
    await vscode.window.showTextDocument(uri, { preview: true });
    this.logger.info("Opened file at revision", { operation: "openFileAtRevision" });
  }

  public async setFilesLayout(layout: FilesLayout): Promise<void> {
    this.applyFilesLayout(layout);
    await this.context.workspaceState.update(FILES_LAYOUT_STORAGE_KEY, layout);
  }

  public calculateComparison(
    comparison: SavedComparisonV1,
    signal?: AbortSignal,
  ): Promise<ComparisonResult> {
    this.logger.info("Calculating comparison", {
      mode: comparison.mode,
      operation: "calculateComparison",
    });
    return calculateComparison(comparison, signal);
  }

  public async openFileDiff(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("RefHaven file selection is invalid.");
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

  private async assertKnownRepositoryRoot(repositoryRootPath: string): Promise<void> {
    const expected = pathIdentityKey(repositoryRootPath);
    const repositories = await discoverRepositories();
    if (!repositories.some(({ rootPath }) => pathIdentityKey(rootPath) === expected)) {
      throw new Error("The selected repository is not part of the current workspace.");
    }
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
        "RefHaven needs at least two local or remote branches.",
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
      await this.revealComparison(existingComparison);
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
    await this.revealComparison(comparison);
  }

  private async revealComparison(comparison: SavedComparisonV1): Promise<void> {
    let node = this.treeProvider.getComparisonNode(comparison.id);
    if (!node) throw new Error("The comparison could not be revealed in the RefHaven view.");

    this.treeProvider.requestComparisonExpansion(comparison.id);
    try {
      await vscode.commands.executeCommand(COMPARISON_VIEW_FOCUS_COMMAND);
      await this.treeView.reveal(node, { focus: true, select: true });

      // Keep the provider-level Expanded state active while Git loads and the
      // tree refreshes. The final reveal then operates on a stable, cached node.
      await this.treeProvider.prepareComparison(comparison.id);
      node = this.treeProvider.getComparisonNode(comparison.id);
      if (!node) throw new Error("The comparison could not be expanded in the RefHaven view.");
      await this.treeView.reveal(node, { expand: 1, focus: true, select: true });
    } finally {
      this.treeProvider.clearComparisonExpansionRequest(comparison.id);
    }
  }
}
