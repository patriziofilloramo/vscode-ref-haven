import { randomUUID } from "node:crypto";
import { dirname, relative } from "node:path";

import * as vscode from "vscode";

import type { Logger } from "./Logger";
import { calculateComparison } from "./ComparisonEngine";
import type { ComparisonStore } from "./ComparisonStore";
import type { ComparisonReviewStore } from "./ComparisonReviewStore";
import {
  comparisonLabel,
  hasSameComparisonIdentity,
  withMode,
  withPinned,
  withSwappedRefs,
  type BranchRef,
  type RepositoryIdentity,
  type SavedComparisonV1,
} from "../domain/comparison";
import {
  filterAndSortComparisonFiles,
  isComparisonFileFilter,
  isComparisonFileSort,
  type ComparisonFileFilter,
  type ComparisonFileSort,
} from "../domain/comparisonReview";
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
  listComparisonRefs,
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
import type { FileNode } from "../ui/tree/changeNodes";
import {
  BinaryRevisionError,
  type GitRevisionContentProvider,
} from "../ui/documents/GitRevisionContentProvider";

const FILES_LAYOUT_STORAGE_KEY = "refhaven.view.filesLayout";
const FILES_LAYOUT_CONTEXT_KEY = "refhaven.filesLayout";
const FILE_FILTER_STORAGE_KEY = "refhaven.view.comparisonFileFilter";
const FILE_SORT_STORAGE_KEY = "refhaven.view.comparisonFileSort";

export class ComparisonController {
  private readonly reviewNavigationAnchors = new Map<string, string>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ComparisonStore,
    private readonly treeProvider: ComparisonTreeProvider,
    private readonly treeView: vscode.TreeView<ComparisonTreeNode>,
    private readonly logger: Logger,
    private readonly revisionProvider: GitRevisionContentProvider,
    private readonly reviewStore: ComparisonReviewStore,
  ) {}

  public initialize(): void {
    const layout = this.context.workspaceState.get<unknown>(FILES_LAYOUT_STORAGE_KEY, "tree");
    const filter = this.context.workspaceState.get<unknown>(FILE_FILTER_STORAGE_KEY, "all");
    const sort = this.context.workspaceState.get<unknown>(FILE_SORT_STORAGE_KEY, "path");
    this.applyFilesLayout(layout === "list" ? "list" : "tree");
    this.treeProvider.setFileFilter(isComparisonFileFilter(filter) ? filter : "all");
    this.treeProvider.setFileSort(isComparisonFileSort(sort) ? sort : "path");
    this.treeProvider.setReviewStateProvider((result) => this.reviewStore.getSummary(result));
    const comparisons = this.store.getAll();
    this.treeProvider.setComparisons(comparisons);
    void this.reviewStore
      .prune(new Set(comparisons.map(({ id }) => id)))
      .catch((error: unknown) => {
        this.logger.error("Comparison review cleanup failed", {
          message: error instanceof Error ? error.message : String(error),
          operation: "pruneComparisonReviews",
        });
      });
  }

  public async newComparison(): Promise<void> {
    await this.createComparison({ useCurrentBranchAsTarget: false });
  }

  public async compareCurrentBranch(): Promise<void> {
    await this.createComparison({ useCurrentBranchAsTarget: true });
  }

  public async compareReferenceWithCurrent(
    repository: RepositoryIdentity,
    targetRef: BranchRef,
  ): Promise<void> {
    const expectedRoot = pathIdentityKey(repository.rootPath);
    const canonicalRepository = (await discoverRepositories()).find(
      ({ rootPath }) => pathIdentityKey(rootPath) === expectedRoot,
    );
    if (!canonicalRepository) {
      throw new Error("The selected repository is not part of the current workspace.");
    }
    const currentBranchName = await readCurrentBranch(canonicalRepository.rootPath);
    const refs = await listComparisonRefs(canonicalRepository.rootPath);
    const canonicalTarget = refs.find(
      (ref) => ref.fullName === targetRef.fullName && ref.kind === targetRef.kind,
    );
    if (!canonicalTarget || canonicalTarget.kind === "head") {
      throw new Error("The selected branch is no longer available in this repository.");
    }
    const currentRef = currentBranchName
      ? refs.find((ref) => ref.kind === "localBranch" && ref.displayName === currentBranchName)
      : undefined;
    if (!currentRef) {
      void vscode.window.showWarningMessage(
        "The current repository is detached or its current branch is unavailable.",
      );
      return;
    }
    if (currentRef.fullName === canonicalTarget.fullName) {
      void vscode.window.showInformationMessage("This is already the current branch.");
      return;
    }
    await this.saveAndRevealComparison(
      canonicalRepository,
      currentRef,
      canonicalTarget,
      "branchChanges",
    );
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
    if (comparison.mode === "workingTree") {
      void vscode.window.showInformationMessage("Working-tree comparisons cannot be swapped.");
      return;
    }
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
    await this.reviewStore.removeComparison(comparison.id);
    this.reviewNavigationAnchors.delete(comparison.id);
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
    if (comparison.mode === "workingTree") {
      void vscode.window.showInformationMessage(
        "Working-tree comparisons have a fixed comparison mode.",
      );
      return;
    }
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
    await this.reviewStore.removeComparison(comparison.id);
    this.reviewNavigationAnchors.delete(comparison.id);
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
    await this.reviewStore.removeComparison(comparison.id);
    this.reviewNavigationAnchors.delete(comparison.id);
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

  public async openChangedFileAtRevision(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("RefHaven file selection is invalid.");
    }

    if (file.status !== "deleted" && scope.toSha === null) {
      await this.openWorkingTreeFile(scope, file);
      return;
    }

    const sha = file.status === "deleted" ? scope.fromSha : scope.toSha;
    const filePath = file.status === "deleted" ? (file.oldPath ?? file.newPath) : file.newPath;
    if (sha === null) {
      void vscode.window.showInformationMessage(
        "This side of the comparison has no file revision.",
      );
      return;
    }
    const uri = this.revisionProvider.createRevisionUri(scope.repositoryRootPath, sha, filePath);
    await vscode.window.showTextDocument(uri, { preview: true });
    this.logger.info("Opened compared file revision", {
      operation: "openChangedFileAtRevision",
    });
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

    const branches = await listComparisonRefs(repositoryRoot);
    if (branches.length === 0) {
      void vscode.window.showWarningMessage("This repository has no branches to open from.");
      return;
    }
    const currentBranchName = await readCurrentBranch(repositoryRoot);
    const ref = await pickBranch(
      branches,
      `Select the revision of ${relativePath} to open`,
      currentBranchName,
      repositoryRoot,
    );
    if (!ref) return;

    const revisionSha = await resolveRef(repositoryRoot, ref.fullName);
    const uri = this.revisionProvider.createRevisionUri(repositoryRoot, revisionSha, relativePath);
    await vscode.window.showTextDocument(uri, { preview: true });
    this.logger.info("Opened file at revision", { operation: "openFileAtRevision" });
  }

  public async setFilesLayout(layout: FilesLayout): Promise<void> {
    if (layout === "tree" && this.treeProvider.getFileSort() !== "path") {
      this.treeProvider.setFileSort("path");
      await this.context.workspaceState.update(FILE_SORT_STORAGE_KEY, "path");
    }
    this.applyFilesLayout(layout);
    await this.context.workspaceState.update(FILES_LAYOUT_STORAGE_KEY, layout);
  }

  public async changeComparisonFileFilter(): Promise<void> {
    const current = this.treeProvider.getFileFilter();
    const options: readonly (vscode.QuickPickItem & {
      readonly value: ComparisonFileFilter;
    })[] = [
      {
        ...(current === "all" ? { description: "current" } : {}),
        label: "$(list-unordered) All changed files",
        value: "all",
      },
      {
        ...(current === "unreviewed" ? { description: "current" } : {}),
        label: "$(circle-large-outline) Unreviewed only",
        value: "unreviewed",
      },
      {
        ...(current === "reviewed" ? { description: "current" } : {}),
        label: "$(pass-filled) Reviewed only",
        value: "reviewed",
      },
    ];
    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: "Choose which comparison files are visible",
      title: "RefHaven: Comparison File Filter",
    });
    if (!selected || selected.value === current) return;
    this.treeProvider.setFileFilter(selected.value);
    await this.context.workspaceState.update(FILE_FILTER_STORAGE_KEY, selected.value);
  }

  public async changeComparisonFileSort(): Promise<void> {
    const current = this.treeProvider.getFileSort();
    const options: readonly (vscode.QuickPickItem & {
      readonly value: ComparisonFileSort;
    })[] = [
      {
        ...(current === "path" ? { description: "current" } : {}),
        label: "$(symbol-file) Path",
        value: "path",
      },
      {
        ...(current === "status" ? { description: "current" } : {}),
        label: "$(diff) Status, then path",
        value: "status",
      },
      {
        ...(current === "changes" ? { description: "current" } : {}),
        label: "$(graph-line) Largest change first",
        value: "changes",
      },
    ];
    const selected = await vscode.window.showQuickPick(options, {
      placeHolder: "Choose how comparison files are ordered",
      title: "RefHaven: Comparison File Sort",
    });
    if (!selected || selected.value === current) return;
    if (selected.value !== "path" && this.treeProvider.getFilesLayout() !== "list") {
      this.applyFilesLayout("list");
      await this.context.workspaceState.update(FILES_LAYOUT_STORAGE_KEY, "list");
    }
    this.treeProvider.setFileSort(selected.value);
    await this.context.workspaceState.update(FILE_SORT_STORAGE_KEY, selected.value);
  }

  public async markFileReviewed(node: FileNode, reviewed: boolean): Promise<void> {
    if (!node.review) throw new Error("Select a file from a saved comparison first.");
    const result = await this.treeProvider.loadComparisonResult(node.review.comparisonId);
    await this.reviewStore.setReviewed(
      result,
      node.file.newPath,
      reviewed,
      node.review.revisionKey,
    );
    this.reviewNavigationAnchors.set(result.comparison.id, node.file.newPath);
    this.treeProvider.refreshReviewState(result.comparison.id);
  }

  public async setAllComparisonFilesReviewed(
    comparison: SavedComparisonV1,
    reviewed: boolean,
  ): Promise<void> {
    const result = await this.requireReviewResult(comparison);
    await this.reviewStore.setAllReviewed(result, reviewed);
    this.reviewNavigationAnchors.delete(comparison.id);
    this.treeProvider.refreshReviewState(comparison.id);
    void vscode.window.showInformationMessage(
      reviewed ? "All comparison files marked reviewed." : "Comparison review reset.",
    );
  }

  public async openAdjacentUnreviewedFile(
    direction: "next" | "previous",
    candidate?: FileNode | SavedComparisonV1,
  ): Promise<void> {
    const candidateComparison = candidate && "schemaVersion" in candidate ? candidate : undefined;
    const candidateFile = candidate && "kind" in candidate ? candidate : undefined;
    const comparison = candidateComparison
      ? this.requireStoredComparison(candidateComparison)
      : await this.pickReviewComparison(candidateFile?.review?.comparisonId);
    if (!comparison) return;
    const result = await this.treeProvider.loadComparisonResult(comparison.id);
    const review = this.reviewStore.getSummary(result);
    const files = filterAndSortComparisonFiles(
      result.files,
      review.reviewedPaths,
      "all",
      this.treeProvider.getFileSort(),
    );
    if (files.length === 0) {
      void vscode.window.showInformationMessage("This comparison has no changed files.");
      return;
    }
    if (review.reviewedCount === review.totalCount) {
      void vscode.window.showInformationMessage("All files in this comparison are reviewed.");
      return;
    }
    const anchor = candidateFile?.file.newPath ?? this.reviewNavigationAnchors.get(comparison.id);
    const anchorIndex = anchor ? files.findIndex(({ newPath }) => newPath === anchor) : -1;
    const step = direction === "next" ? 1 : -1;
    let index = anchorIndex < 0 ? (direction === "next" ? -1 : 0) : anchorIndex;
    let selected: FileChange | undefined;
    let checked = 0;
    while (checked < files.length) {
      index = (index + step + files.length) % files.length;
      const file = files[index];
      if (file && !review.reviewedPaths.has(file.newPath)) {
        selected = file;
        break;
      }
      checked += 1;
    }
    if (!selected) return;
    this.reviewNavigationAnchors.set(comparison.id, selected.newPath);
    await this.openFileDiff(comparisonScope(result), selected);
  }

  public async quickOpenComparisonFile(comparison?: SavedComparisonV1): Promise<void> {
    const selectedComparison = comparison
      ? this.requireStoredComparison(comparison)
      : await this.pickReviewComparison();
    if (!selectedComparison) return;
    const result = await this.treeProvider.loadComparisonResult(selectedComparison.id);
    const review = this.reviewStore.getSummary(result);
    const files = filterAndSortComparisonFiles(
      result.files,
      review.reviewedPaths,
      this.treeProvider.getFileFilter(),
      this.treeProvider.getFileSort(),
    );
    if (files.length === 0) {
      void vscode.window.showInformationMessage("No comparison files match the current filter.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      files.map((file) => ({
        description: review.reviewedPaths.has(file.newPath) ? "reviewed" : "unreviewed",
        detail:
          file.additions === undefined && file.deletions === undefined
            ? `${file.status} · binary`
            : `${file.status} · ${formatDiffStats(file.additions ?? 0, file.deletions ?? 0)}`,
        file,
        label: file.newPath,
      })),
      {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: "Type to find a changed file",
        title: `RefHaven: ${comparisonLabel(selectedComparison)}`,
      },
    );
    if (!selected) return;
    this.reviewNavigationAnchors.set(selectedComparison.id, selected.file.newPath);
    await this.openFileDiff(comparisonScope(result), selected.file);
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
        : scope.toSha === null
          ? vscode.Uri.file(resolvePathWithinRepository(repositoryRoot, file.newPath))
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

  private async pickReviewComparison(preferredId?: string): Promise<SavedComparisonV1 | undefined> {
    const comparisons = this.store.getAll();
    const preferred = preferredId
      ? comparisons.find((comparison) => comparison.id === preferredId)
      : undefined;
    if (preferred) return preferred;
    if (comparisons.length === 0) {
      void vscode.window.showInformationMessage("Create a branch comparison first.");
      return undefined;
    }
    if (comparisons.length === 1) return comparisons[0];
    const selected = await vscode.window.showQuickPick(
      comparisons.map((comparison) => ({
        comparison,
        description: comparison.repository.label,
        label: comparisonLabel(comparison),
      })),
      {
        matchOnDescription: true,
        placeHolder: "Select a saved comparison",
        title: "RefHaven: Comparison Review",
      },
    );
    return selected?.comparison;
  }

  private requireStoredComparison(comparison: SavedComparisonV1): SavedComparisonV1 {
    const current = this.store.getAll().find(({ id }) => id === comparison.id);
    if (!current) throw new Error("The selected comparison is no longer available.");
    return current;
  }

  private async requireReviewResult(comparison: SavedComparisonV1): Promise<ComparisonResult> {
    const current = this.requireStoredComparison(comparison);
    return this.treeProvider.loadComparisonResult(current.id);
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

    const branches = await listComparisonRefs(repository.rootPath);
    if (branches.length < 2) {
      void vscode.window.showWarningMessage("RefHaven needs at least two local references.");
      return;
    }

    const currentBranchName = await readCurrentBranch(repository.rootPath);
    const currentBranch = currentBranchName
      ? branches.find((branch) => branch.displayName === currentBranchName)
      : undefined;

    const targetRef = options.useCurrentBranchAsTarget
      ? currentBranch
      : await pickBranch(
          branches,
          "Select the reference to analyse",
          currentBranchName,
          repository.rootPath,
          true,
        );
    if (!targetRef) {
      if (options.useCurrentBranchAsTarget) {
        void vscode.window.showWarningMessage(
          "The current repository is detached or its current branch is unavailable.",
        );
      }
      return;
    }

    const baseRef = await pickBranch(
      branches.filter(
        (branch) => branch.fullName !== targetRef.fullName && branch.kind !== "workingTree",
      ),
      `Select the base reference for ${targetRef.displayName}`,
      undefined,
      repository.rootPath,
    );
    if (!baseRef) return;

    const mode =
      targetRef.kind === "workingTree" ? ("workingTree" as const) : ("branchChanges" as const);
    await this.saveAndRevealComparison(repository, baseRef, targetRef, mode);
  }

  private async saveAndRevealComparison(
    repository: RepositoryIdentity,
    baseRef: BranchRef,
    targetRef: BranchRef,
    mode: SavedComparisonV1["mode"],
  ): Promise<void> {
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

function comparisonScope(result: ComparisonResult): FileDiffScope {
  return {
    fromSha: result.fromSha,
    label: comparisonLabel(result.comparison),
    repositoryRootPath: result.comparison.repository.rootPath,
    toSha: result.toSha,
  };
}
