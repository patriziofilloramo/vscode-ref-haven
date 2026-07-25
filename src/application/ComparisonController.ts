import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import type { Logger } from "./Logger";
import { calculateComparison } from "./ComparisonEngine";
import {
  COMPARISON_STORAGE_KEY,
  deduplicateComparisons,
  hasSameComparisonIdentity,
  type BranchRef,
  type RepositoryIdentity,
  type SavedComparisonV1,
} from "../domain/comparison";
import type { ComparisonResult, FileChange } from "../domain/comparisonResult";
import {
  discoverRepositories,
  listBranchRefs,
  readCurrentBranch,
} from "../infrastructure/git/GitCli";
import type { ComparisonTreeProvider } from "../ui/tree/ComparisonTreeProvider";
import {
  BinaryRevisionError,
  type GitRevisionContentProvider,
} from "../ui/documents/GitRevisionContentProvider";

export class ComparisonController {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly treeProvider: ComparisonTreeProvider,
    private readonly logger: Logger,
    private readonly revisionProvider: GitRevisionContentProvider,
  ) {}

  public initialize(): void {
    const storedComparisons = this.loadStoredComparisons();
    const comparisons = deduplicateComparisons(storedComparisons);
    this.treeProvider.setComparisons(comparisons);

    const removedCount = storedComparisons.length - comparisons.length;
    if (removedCount > 0) {
      void this.persistDeduplicatedComparisons(comparisons, removedCount);
    }
  }

  public async newComparison(): Promise<void> {
    await this.createComparison({ useCurrentBranchAsTarget: false });
  }

  public async compareCurrentBranch(): Promise<void> {
    await this.createComparison({ useCurrentBranchAsTarget: true });
  }

  public refreshAll(): void {
    const comparisons = this.loadComparisons();
    this.treeProvider.invalidateResults();
    this.treeProvider.setComparisons(comparisons);
    this.logger.info("Refreshed saved comparisons", {
      count: comparisons.length,
      operation: "refreshAll",
    });
    void vscode.window.showInformationMessage(
      `Refreshed ${comparisons.length.toString()} comparison(s).`,
    );
  }

  public calculateComparison(comparison: SavedComparisonV1): Promise<ComparisonResult> {
    this.logger.info("Calculating comparison", {
      mode: comparison.mode,
      operation: "calculateComparison",
    });
    return calculateComparison(comparison);
  }

  public async openFileDiff(result: ComparisonResult, file: FileChange): Promise<void> {
    if (!isComparisonResult(result) || !isFileChange(file)) {
      throw new Error("Branch Compare file selection is invalid.");
    }

    const repositoryRoot = result.comparison.repository.rootPath;
    const oldPath = file.oldPath ?? file.newPath;
    const left =
      file.status === "added"
        ? this.revisionProvider.createEmptyUri(file.newPath)
        : this.revisionProvider.createRevisionUri(repositoryRoot, result.fromSha, oldPath);
    const right =
      file.status === "deleted"
        ? this.revisionProvider.createEmptyUri(file.newPath)
        : this.revisionProvider.createRevisionUri(repositoryRoot, result.toSha, file.newPath);

    try {
      await this.revisionProvider.prepareTextDiff(left, right);
    } catch (error) {
      if (error instanceof BinaryRevisionError) {
        void vscode.window.showInformationMessage(`Binary file changed: ${file.newPath}`);
        return;
      }
      throw error;
    }

    const title = `${file.newPath} (${result.comparison.targetRef.displayName} relative to ${result.comparison.baseRef.displayName})`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
  }

  private async createComparison(options: {
    readonly useCurrentBranchAsTarget: boolean;
  }): Promise<void> {
    const repository = await this.pickRepository();
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
    const comparisons = this.loadComparisons();
    const existingComparison = comparisons.find((comparison) =>
      hasSameComparisonIdentity(comparison, { baseRef, mode, repository, targetRef }),
    );

    if (existingComparison) {
      await this.context.workspaceState.update(COMPARISON_STORAGE_KEY, comparisons);
      this.treeProvider.setComparisons(comparisons);
      this.logger.info("Skipped duplicate comparison", {
        mode,
        operation: "newComparison",
      });
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
      order: nextComparisonOrder(comparisons),
      pinned: false,
      repository,
      schemaVersion: 1,
      targetRef,
      updatedAt: now,
    };

    const updatedComparisons = [...comparisons, comparison];
    await this.context.workspaceState.update(COMPARISON_STORAGE_KEY, updatedComparisons);
    this.treeProvider.setComparisons(updatedComparisons);
    this.logger.info("Created comparison", {
      mode: comparison.mode,
      operation: "newComparison",
    });
    void vscode.window.showInformationMessage(
      `Created comparison: ${targetRef.displayName} relative to ${baseRef.displayName}.`,
    );
  }

  private async pickRepository(): Promise<RepositoryIdentity | null> {
    const repositories = await discoverRepositories();
    if (repositories.length === 0) {
      void vscode.window.showWarningMessage("Open a Git workspace before creating a comparison.");
      return null;
    }
    if (repositories.length === 1) return repositories[0] ?? null;

    const selected = await vscode.window.showQuickPick(
      repositories.map((repository) => ({
        description: repository.rootPath,
        label: repository.label,
        repository,
      })),
      {
        matchOnDescription: true,
        placeHolder: "Select a repository",
        title: "Branch Compare: New Comparison",
      },
    );
    return selected?.repository ?? null;
  }

  private loadComparisons(): SavedComparisonV1[] {
    return deduplicateComparisons(this.loadStoredComparisons());
  }

  private loadStoredComparisons(): SavedComparisonV1[] {
    const raw = this.context.workspaceState.get<unknown>(COMPARISON_STORAGE_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isSavedComparisonV1).sort((left, right) => left.order - right.order);
  }

  private async persistDeduplicatedComparisons(
    comparisons: readonly SavedComparisonV1[],
    removedCount: number,
  ): Promise<void> {
    try {
      await this.context.workspaceState.update(COMPARISON_STORAGE_KEY, comparisons);
      this.logger.info("Removed duplicate saved comparisons", {
        count: removedCount,
        operation: "restoreComparisons",
      });
    } catch {
      this.logger.error("Could not persist deduplicated comparisons", {
        count: removedCount,
        operation: "restoreComparisons",
      });
    }
  }
}

function nextComparisonOrder(comparisons: readonly SavedComparisonV1[]): number {
  return (
    comparisons.reduce((highestOrder, comparison) => {
      return Math.max(highestOrder, comparison.order);
    }, -1) + 1
  );
}

async function pickBranch(
  branches: readonly BranchRef[],
  placeHolder: string,
  preferredBranch?: string | null,
): Promise<BranchRef | null> {
  const sorted = [...branches].sort((left, right) => {
    if (preferredBranch && left.displayName === preferredBranch) return -1;
    if (preferredBranch && right.displayName === preferredBranch) return 1;
    return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
  });
  const selected = await vscode.window.showQuickPick(
    sorted.map((branch) => ({
      description: branch.kind === "localBranch" ? "local" : "remote",
      label: branch.displayName,
      branch,
    })),
    {
      matchOnDescription: true,
      placeHolder,
      title: "Branch Compare: New Comparison",
    },
  );
  return selected?.branch ?? null;
}

function isSavedComparisonV1(value: unknown): value is SavedComparisonV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SavedComparisonV1>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.order === "number" &&
    typeof candidate.repository?.rootPath === "string" &&
    typeof candidate.repository.workspaceFolderUri === "string" &&
    typeof candidate.repository.relativeRepositoryPath === "string" &&
    typeof candidate.repository.label === "string" &&
    isBranchRef(candidate.baseRef) &&
    isBranchRef(candidate.targetRef)
  );
}

function isBranchRef(value: unknown): value is BranchRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BranchRef>;
  return (
    typeof candidate.displayName === "string" &&
    typeof candidate.fullName === "string" &&
    (candidate.kind === "localBranch" || candidate.kind === "remoteBranch")
  );
}

function isFileChange(value: unknown): value is FileChange {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileChange>;
  return (
    typeof candidate.newPath === "string" &&
    ["added", "copied", "deleted", "modified", "renamed", "typeChanged", "unmerged"].includes(
      candidate.status ?? "",
    )
  );
}

function isComparisonResult(value: unknown): value is ComparisonResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!candidate.comparison || typeof candidate.comparison !== "object") return false;
  const comparison = candidate.comparison as Record<string, unknown>;
  if (!comparison.repository || typeof comparison.repository !== "object") return false;
  const repository = comparison.repository as Record<string, unknown>;
  return (
    typeof comparison.id === "string" &&
    typeof repository.rootPath === "string" &&
    typeof candidate.fromSha === "string" &&
    /^[0-9a-f]{40,64}$/i.test(candidate.fromSha) &&
    typeof candidate.toSha === "string" &&
    /^[0-9a-f]{40,64}$/i.test(candidate.toSha)
  );
}
