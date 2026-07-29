import { randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";

import * as vscode from "vscode";

import type { Logger } from "./Logger";
import { calculateComparison } from "./ComparisonEngine";
import { errorLogMetadata } from "./errorHandling";
import type { ComparisonStore } from "./ComparisonStore";
import type { ComparisonReviewStore } from "./ComparisonReviewStore";
import {
  comparisonLabel,
  hasSameComparisonIdentity,
  isValidCustomLabel,
  MAX_CUSTOM_LABEL_LENGTH,
  withCustomLabel,
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
import { showTransientSuccess } from "../ui/feedback";
import { isFileChange, isFileDiffScope } from "../domain/validation";
import {
  findRepositoryRoot,
  listComparisonRefs,
  discoverRepositories,
  readComparisonPatch,
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

type RepositoryDiscovery = () => Promise<readonly RepositoryIdentity[]>;

export class ComparisonController {
  private readonly availableRepositoryRoots = new Set<string>();
  private readonly reviewNavigationAnchors = new Map<string, string>();
  private workspaceRepositoryRefreshGeneration = 0;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ComparisonStore,
    private readonly treeProvider: ComparisonTreeProvider,
    private readonly treeView: vscode.TreeView<ComparisonTreeNode>,
    private readonly logger: Logger,
    private readonly revisionProvider: GitRevisionContentProvider,
    private readonly reviewStore: ComparisonReviewStore,
    private readonly repositoryDiscovery: RepositoryDiscovery = discoverRepositories,
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
    // Repository discovery is asynchronous. Keep persisted comparisons hidden
    // until their repository roots have been re-established from the current
    // trusted workspace rather than trusting paths restored from storage.
    this.setVisibleComparisons(comparisons);
    void this.reviewStore
      .prune(new Set(comparisons.map(({ id }) => id)))
      .catch((error: unknown) => {
        this.logger.error(
          "Comparison review cleanup failed",
          errorLogMetadata(error, "pruneComparisonReviews"),
        );
      });
  }

  /**
   * Re-evaluates which persisted comparisons belong to the current workspace.
   * Stored comparisons are intentionally retained so they can reappear if their
   * workspace folder is added again later.
   */
  public async refreshAvailableComparisons(clearBeforeDiscovery = true): Promise<void> {
    const generation = ++this.workspaceRepositoryRefreshGeneration;

    if (clearBeforeDiscovery) {
      // Close the time-of-check gap on workspace-folder removal: stale nodes
      // become unavailable before asynchronous discovery starts.
      this.availableRepositoryRoots.clear();
      this.treeProvider.invalidateAllResults();
      this.setVisibleComparisons(this.store.getAll());
    }

    const repositories = await this.repositoryDiscovery();
    if (generation !== this.workspaceRepositoryRefreshGeneration) return;

    this.availableRepositoryRoots.clear();
    for (const { rootPath } of repositories) {
      this.availableRepositoryRoots.add(pathIdentityKey(rootPath));
    }
    // Discovery changes which comparisons are available, not their immutable
    // Git results. setComparisons removes state for comparisons that disappeared
    // while preserving cached results for those that remain visible.
    this.setVisibleComparisons(this.store.getAll());
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
    const canonicalRepository = (await this.repositoryDiscovery()).find(
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

  public async compareReferences(
    repository: RepositoryIdentity,
    baseRef: BranchRef,
    targetRef: BranchRef,
  ): Promise<void> {
    const expectedRoot = pathIdentityKey(repository.rootPath);
    const canonicalRepository = (await this.repositoryDiscovery()).find(
      ({ rootPath }) => pathIdentityKey(rootPath) === expectedRoot,
    );
    if (!canonicalRepository) {
      throw new Error("The selected repository is not part of the current workspace.");
    }
    const refs = await listComparisonRefs(canonicalRepository.rootPath);
    const canonicalBase = refs.find(
      (ref) => ref.fullName === baseRef.fullName && ref.kind === baseRef.kind,
    );
    const canonicalTarget = refs.find(
      (ref) => ref.fullName === targetRef.fullName && ref.kind === targetRef.kind,
    );
    if (!canonicalBase || !canonicalTarget) {
      throw new Error("One of the selected branches is no longer available.");
    }
    if (canonicalBase.fullName === canonicalTarget.fullName) {
      throw new Error("Select two different branches to create a comparison.");
    }
    await this.saveAndRevealComparison(
      canonicalRepository,
      canonicalBase,
      canonicalTarget,
      "branchChanges",
    );
  }

  public refreshAll(): void {
    const comparisons = this.store.getAll();
    this.treeProvider.invalidateAllResults();
    this.setVisibleComparisons(comparisons);
    this.logger.info("Refreshed saved comparisons", {
      count: this.visibleComparisons(comparisons).length,
      operation: "refreshAll",
    });
  }

  public refreshComparison(comparison: SavedComparisonV1): void {
    const current = this.requireStoredComparison(comparison);
    this.assertCachedRepositoryRoot(current.repository.rootPath);
    this.treeProvider.invalidateResult(current.id);
    this.logger.info("Refreshed comparison", { operation: "refreshComparison" });
  }

  /** Marks mutable Working Tree results stale without touching immutable comparisons. */
  public refreshWorkingTreeComparisons(): void {
    const workingTreeComparisons = this.store
      .getAll()
      .filter(
        (comparison) =>
          comparison.mode === "workingTree" &&
          this.availableRepositoryRoots.has(pathIdentityKey(comparison.repository.rootPath)),
      );
    this.treeProvider.invalidateResults(new Set(workingTreeComparisons.map(({ id }) => id)));
    if (workingTreeComparisons.length > 0) {
      this.logger.debug("Invalidated working-tree comparisons", {
        count: workingTreeComparisons.length,
        operation: "refreshWorkingTreeComparisons",
      });
    }
  }

  public async swapComparison(comparison: SavedComparisonV1): Promise<void> {
    comparison = await this.requireAvailableStoredComparison(comparison);
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
    this.setVisibleComparisons(comparisons);
    this.logger.info("Swapped comparison direction", { operation: "swapComparison" });
  }

  /**
   * Switches between branch-changes (merge base → target) and tip-to-tip
   * (base → target) diffs. Tip-to-tip shows the full difference even when the
   * target has no commits of its own, which branch-changes renders as empty.
   */
  public async changeComparisonMode(comparison: SavedComparisonV1): Promise<void> {
    comparison = await this.requireAvailableStoredComparison(comparison);
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
    this.setVisibleComparisons(comparisons);
    this.logger.info("Changed comparison mode", {
      mode: selected.mode,
      operation: "changeComparisonMode",
    });
  }

  public async setPinned(comparison: SavedComparisonV1, pinned: boolean): Promise<void> {
    comparison = await this.requireAvailableStoredComparison(comparison);
    const comparisons = await this.store.replace(comparison.id, (current) =>
      withPinned(current, pinned, Date.now()),
    );
    this.setVisibleComparisons(comparisons);
    this.logger.info(pinned ? "Pinned comparison" : "Unpinned comparison", {
      operation: "setPinned",
    });
  }

  /** Sets or clears the comparison's display name; an empty input restores the default. */
  public async renameComparison(comparison: SavedComparisonV1): Promise<void> {
    comparison = await this.requireAvailableStoredComparison(comparison);
    const defaultLabel = `${comparison.targetRef.displayName} relative to ${comparison.baseRef.displayName}`;
    const value = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: defaultLabel,
      prompt: "Enter a display name for this comparison. Leave empty to restore the default.",
      title: "RefHaven: Rename Comparison",
      validateInput: (input) =>
        input.trim().length === 0 || isValidCustomLabel(input.trim())
          ? undefined
          : `Use at most ${MAX_CUSTOM_LABEL_LENGTH.toString()} printable characters.`,
      value: comparison.customLabel ?? "",
    });
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length > 0 && !isValidCustomLabel(trimmed)) {
      throw new Error("The comparison name is invalid.");
    }
    const comparisons = await this.store.replace(comparison.id, (current) =>
      withCustomLabel(current, trimmed.length === 0 ? undefined : trimmed, Date.now()),
    );
    this.setVisibleComparisons(comparisons);
    this.logger.info(trimmed.length === 0 ? "Restored comparison label" : "Renamed comparison", {
      operation: "renameComparison",
    });
  }

  public async closeComparison(comparison: SavedComparisonV1): Promise<void> {
    comparison = await this.requireAvailableStoredComparison(comparison);
    const comparisons = await this.store.remove(comparison.id);
    await this.reviewStore.removeComparison(comparison.id);
    this.reviewNavigationAnchors.delete(comparison.id);
    this.setVisibleComparisons(comparisons);
    this.logger.info("Closed comparison", { operation: "closeComparison" });
  }

  public async copyComparisonSummary(comparison: SavedComparisonV1): Promise<void> {
    comparison = await this.requireAvailableStoredComparison(comparison);
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
    showTransientSuccess("Comparison summary copied");
  }

  public async copyCommitSha(commit: CommitInfo): Promise<void> {
    await vscode.env.clipboard.writeText(commit.sha);
    showTransientSuccess(`Commit ${shortSha(commit.sha)} copied`);
  }

  public async copyCommitMessage(commit: CommitInfo): Promise<void> {
    await vscode.env.clipboard.writeText(commit.subject);
    showTransientSuccess("Commit message copied");
  }

  public async openWorkingTreeFile(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("RefHaven file selection is invalid.");
    }
    await this.assertKnownRepositoryRoot(scope.repositoryRootPath);
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
    await this.assertKnownRepositoryRoot(scope.repositoryRootPath);

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

  /** Exports the comparison's full diff as a shareable unified patch. */
  public async exportComparisonPatch(
    comparison: SavedComparisonV1,
    destination: "clipboard" | "file",
  ): Promise<void> {
    comparison = await this.requireAvailableStoredComparison(comparison);
    const result = await this.treeProvider.loadComparisonResult(comparison.id);
    await this.assertKnownRepositoryRoot(result.comparison.repository.rootPath);
    const patch = await readComparisonPatch(
      result.comparison.repository.rootPath,
      result.fromSha,
      result.toSha,
    );
    if (patch.length === 0) {
      void vscode.window.showInformationMessage("This comparison has no differences to export.");
      return;
    }
    if (destination === "clipboard") {
      // The clipboard is inherently text; non-UTF-8 bytes are decoded
      // best-effort. Saving to a file preserves the exact bytes.
      await vscode.env.clipboard.writeText(patch.toString("utf8"));
      showTransientSuccess(`Patch for ${comparisonLabel(comparison)} copied`);
    } else {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          join(result.comparison.repository.rootPath, `${patchFileName(comparison)}.patch`),
        ),
        filters: { "Patch files": ["patch", "diff"] },
        title: "RefHaven: Save Comparison Patch",
      });
      if (!target) return;
      if (target.scheme !== "file") {
        throw new Error("Comparison patches can only be saved to the local filesystem.");
      }
      await vscode.workspace.fs.writeFile(target, patch);
      void vscode.window.showInformationMessage(`Patch saved to ${target.fsPath}.`);
    }
    this.logger.info("Exported comparison patch", {
      destination,
      operation: "exportComparisonPatch",
    });
  }

  /** Copies one changed file's diff, in the node's own comparison scope. */
  public async copyFilePatch(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("RefHaven file selection is invalid.");
    }
    await this.assertKnownRepositoryRoot(scope.repositoryRootPath);
    const paths =
      file.oldPath && file.oldPath !== file.newPath ? [file.newPath, file.oldPath] : [file.newPath];
    const patch = await readComparisonPatch(
      scope.repositoryRootPath,
      scope.fromSha,
      scope.toSha,
      paths,
    );
    if (patch.length === 0) {
      void vscode.window.showInformationMessage(`${file.newPath} has no textual patch to copy.`);
      return;
    }
    await vscode.env.clipboard.writeText(patch.toString("utf8"));
    showTransientSuccess(`Patch for ${file.newPath} copied`);
  }

  public async copyFilePath(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("RefHaven file selection is invalid.");
    }
    await this.assertKnownRepositoryRoot(scope.repositoryRootPath);
    await vscode.env.clipboard.writeText(
      resolvePathWithinRepository(scope.repositoryRootPath, file.newPath),
    );
    showTransientSuccess("File path copied");
  }

  public async copyRelativeFilePath(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("RefHaven file selection is invalid.");
    }
    await this.assertKnownRepositoryRoot(scope.repositoryRootPath);
    await vscode.env.clipboard.writeText(file.newPath);
    showTransientSuccess("Relative file path copied");
  }

  public async revealFileInComparison(repositoryRootPath: string, filePath: string): Promise<void> {
    await this.assertKnownRepositoryRoot(repositoryRootPath);
    const comparisons = this.store
      .getAll()
      .filter(
        ({ repository }) =>
          pathIdentityKey(repository.rootPath) === pathIdentityKey(repositoryRootPath),
      );
    if (comparisons.length === 0) {
      void vscode.window.showInformationMessage(
        "Create a branch comparison for this repository first.",
      );
      return;
    }

    const selectedId = comparisonIdFromTreeNode(this.treeView.selection[0]);
    let comparison = comparisons.find(({ id }) => id === selectedId);
    if (!comparison && comparisons.length === 1) comparison = comparisons[0];
    if (!comparison) {
      const selected = await vscode.window.showQuickPick(
        comparisons.map((candidate) => ({
          comparison: candidate,
          description: candidate.repository.label,
          label: comparisonLabel(candidate),
        })),
        {
          matchOnDescription: true,
          placeHolder: filePath,
          title: "RefHaven: Reveal File in Comparison",
        },
      );
      comparison = selected?.comparison;
    }
    if (!comparison) return;

    const result = await this.treeProvider.loadComparisonResult(comparison.id);
    const file = result.files.find(
      (candidate) => candidate.newPath === filePath || candidate.oldPath === filePath,
    );
    if (!file) {
      void vscode.window.showInformationMessage(
        `${filePath} is not changed in ${comparisonLabel(comparison)}.`,
      );
      return;
    }
    if (this.treeProvider.getFileFilter() !== "all") {
      this.treeProvider.setFileFilter("all");
      await this.context.workspaceState.update(FILE_FILTER_STORAGE_KEY, "all");
    }
    const node = await this.treeProvider.findComparisonFileNode(comparison.id, file.newPath);
    if (!node) throw new Error("The comparison file could not be revealed.");
    await vscode.commands.executeCommand(COMPARISON_VIEW_FOCUS_COMMAND);
    await this.treeView.reveal(node, { focus: true, select: true });
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
    const canonicalRepository = await this.assertKnownRepositoryRoot(repositoryRoot);
    const canonicalRepositoryRoot = canonicalRepository.rootPath;
    const relativePath = relative(canonicalRepositoryRoot, fsPath).replaceAll("\\", "/");

    const branches = await listComparisonRefs(canonicalRepositoryRoot);
    if (branches.length === 0) {
      void vscode.window.showWarningMessage("This repository has no branches to open from.");
      return;
    }
    const currentBranchName = await readCurrentBranch(canonicalRepositoryRoot);
    const ref = await pickBranch(
      branches,
      `Select the revision of ${relativePath} to open`,
      currentBranchName,
      canonicalRepositoryRoot,
    );
    if (!ref) return;

    const revisionSha = await resolveRef(canonicalRepositoryRoot, ref.fullName);
    const uri = this.revisionProvider.createRevisionUri(
      canonicalRepositoryRoot,
      revisionSha,
      relativePath,
    );
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
    await this.requireAvailableStoredComparisonById(node.review.comparisonId);
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
      ? await this.requireAvailableStoredComparison(candidateComparison)
      : await this.pickReviewComparison(candidateFile?.review?.comparisonId);
    if (!comparison) return;
    await this.assertKnownRepositoryRoot(comparison.repository.rootPath);
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
      ? await this.requireAvailableStoredComparison(comparison)
      : await this.pickReviewComparison();
    if (!selectedComparison) return;
    await this.assertKnownRepositoryRoot(selectedComparison.repository.rootPath);
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

  public async calculateComparison(
    comparison: SavedComparisonV1,
    signal?: AbortSignal,
  ): Promise<ComparisonResult> {
    const current = this.requireStoredComparison(comparison);
    const repository = await this.assertKnownRepositoryRoot(current.repository.rootPath);
    this.logger.info("Calculating comparison", {
      mode: current.mode,
      operation: "calculateComparison",
    });
    return calculateComparison({ ...current, repository }, signal);
  }

  public async openFileDiff(scope: FileDiffScope, file: FileChange): Promise<void> {
    if (!isFileDiffScope(scope) || !isFileChange(file)) {
      throw new Error("RefHaven file selection is invalid.");
    }
    await this.assertKnownRepositoryRoot(scope.repositoryRootPath);

    const { left, right } = this.createFileDiffUris(scope, file);

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

  public async openAllComparisonChanges(comparison: SavedComparisonV1): Promise<void> {
    const current = await this.requireAvailableStoredComparison(comparison);
    const result = await this.treeProvider.loadComparisonResult(current.id);
    await this.assertKnownRepositoryRoot(result.comparison.repository.rootPath);
    const scope = comparisonScope(result);
    const textFiles = result.files.filter(
      ({ additions, deletions }) => additions !== undefined || deletions !== undefined,
    );
    if (textFiles.length === 0) {
      void vscode.window.showInformationMessage(
        result.files.length === 0
          ? "This comparison has no changed files."
          : "This comparison contains only binary changes.",
      );
      return;
    }
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = textFiles.map((file) => {
      const { left, right } = this.createFileDiffUris(scope, file);
      return [
        vscode.Uri.file(resolvePathWithinRepository(scope.repositoryRootPath, file.newPath)),
        left,
        right,
      ];
    });
    await vscode.commands.executeCommand("vscode.changes", comparisonLabel(current), resources);
    const omitted = result.files.length - textFiles.length;
    if (omitted > 0) {
      showTransientSuccess(
        `Opened ${pluralize(textFiles.length, "text change")}; ${pluralize(omitted, "binary change")} omitted`,
      );
    }
  }

  private createFileDiffUris(
    scope: FileDiffScope,
    file: FileChange,
  ): { readonly left: vscode.Uri; readonly right: vscode.Uri } {
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
    return { left, right };
  }

  private applyFilesLayout(layout: FilesLayout): void {
    this.treeProvider.setFilesLayout(layout);
    void vscode.commands.executeCommand("setContext", FILES_LAYOUT_CONTEXT_KEY, layout);
  }

  private async pickReviewComparison(preferredId?: string): Promise<SavedComparisonV1 | undefined> {
    const comparisons = await this.availableStoredComparisons();
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

  private async availableStoredComparisons(): Promise<readonly SavedComparisonV1[]> {
    const repositories = await this.repositoryDiscovery();
    const availableRoots = new Set(repositories.map(({ rootPath }) => pathIdentityKey(rootPath)));
    return this.store
      .getAll()
      .filter(({ repository }) => availableRoots.has(pathIdentityKey(repository.rootPath)));
  }

  private visibleComparisons(
    comparisons: readonly SavedComparisonV1[],
  ): readonly SavedComparisonV1[] {
    return comparisons.filter(({ repository }) =>
      this.availableRepositoryRoots.has(pathIdentityKey(repository.rootPath)),
    );
  }

  private setVisibleComparisons(comparisons: readonly SavedComparisonV1[]): void {
    this.treeProvider.setComparisons(this.visibleComparisons(comparisons));
  }

  private assertCachedRepositoryRoot(repositoryRootPath: string): void {
    if (!this.availableRepositoryRoots.has(pathIdentityKey(repositoryRootPath))) {
      throw new Error("The selected repository is not part of the current workspace.");
    }
  }

  private requireStoredComparison(comparison: SavedComparisonV1): SavedComparisonV1 {
    const current = this.store.getAll().find(({ id }) => id === comparison.id);
    if (!current) throw new Error("The selected comparison is no longer available.");
    return current;
  }

  private async requireAvailableStoredComparison(
    comparison: SavedComparisonV1,
  ): Promise<SavedComparisonV1> {
    const current = this.requireStoredComparison(comparison);
    await this.assertKnownRepositoryRoot(current.repository.rootPath);
    return current;
  }

  private async requireAvailableStoredComparisonById(
    comparisonId: string,
  ): Promise<SavedComparisonV1> {
    const current = this.store.getAll().find(({ id }) => id === comparisonId);
    if (!current) throw new Error("The selected comparison is no longer available.");
    await this.assertKnownRepositoryRoot(current.repository.rootPath);
    return current;
  }

  private async requireReviewResult(comparison: SavedComparisonV1): Promise<ComparisonResult> {
    const current = await this.requireAvailableStoredComparison(comparison);
    return this.treeProvider.loadComparisonResult(current.id);
  }

  private async assertKnownRepositoryRoot(repositoryRootPath: string): Promise<RepositoryIdentity> {
    const generation = this.workspaceRepositoryRefreshGeneration;
    const expected = pathIdentityKey(repositoryRootPath);
    const repositories = await this.repositoryDiscovery();
    if (generation !== this.workspaceRepositoryRefreshGeneration) {
      throw new Error("The workspace changed while validating the selected repository.");
    }
    const repository = repositories.find(({ rootPath }) => pathIdentityKey(rootPath) === expected);
    if (!repository) {
      throw new Error("The selected repository is not part of the current workspace.");
    }
    return repository;
  }

  private async createComparison(options: {
    readonly useCurrentBranchAsTarget: boolean;
  }): Promise<void> {
    const repositories = await this.repositoryDiscovery();
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
    // Callers obtained this canonical identity from fresh workspace discovery.
    this.availableRepositoryRoots.add(pathIdentityKey(repository.rootPath));
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
    this.setVisibleComparisons(comparisons);
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

function comparisonIdFromTreeNode(node: ComparisonTreeNode | undefined): string | undefined {
  if (!node) return undefined;
  switch (node.kind) {
    case "comparison":
      return node.comparison.id;
    case "section":
      return node.result.comparison.id;
    case "commit":
      return node.comparisonId;
    case "file":
      return node.review?.comparisonId;
    case "folder":
      return node.reviewContext?.comparisonId;
    case "message":
      return undefined;
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

/** Derives a portable file name from the comparison label. */
function patchFileName(comparison: SavedComparisonV1): string {
  const name = comparisonLabel(comparison)
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80);
  return name.length > 0 ? `refhaven-${name}` : "refhaven-comparison";
}
