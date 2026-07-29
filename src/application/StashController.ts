import * as vscode from "vscode";

import type { RepositoryIdentity } from "../domain/comparison";
import { MAX_INTERACTIVE_INPUT_LENGTH } from "../domain/inputLimits";
import type { Logger } from "./Logger";
import { showTransientSuccess } from "../ui/feedback";
import type { StashEntry } from "../domain/stash";
import {
  discoverRepositories,
  listPendingStashFileRecoveries,
  stashTrackedFile,
  StashCleanupIncompleteError,
} from "../infrastructure/git/GitCli";
import type { StashTreeProvider } from "../ui/tree/StashTreeProvider";

export class StashController {
  public constructor(
    private readonly treeProvider: StashTreeProvider,
    private readonly logger: Logger,
  ) {}

  public async initialize(): Promise<void> {
    const repositories = await this.refreshRepositories();
    const recoveryResults = await Promise.allSettled(
      repositories.map(({ rootPath }) => listPendingStashFileRecoveries(rootPath)),
    );
    const pending = recoveryResults.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const failedScans = recoveryResults.filter(({ status }) => status === "rejected").length;
    if (pending.length === 0 && failedScans === 0) return;

    this.logger.warn("Detected unfinished or unreadable single-file stash recovery state", {
      failedScans,
      operation: "stashFileRecoveryScan",
      pendingRecoveryCount: pending.length,
    });
    const selection = await vscode.window.showWarningMessage(
      pending.length > 0
        ? `RefHaven found ${pending.length.toString()} unfinished single-file stash recovery record(s). Review the retained data before stashing another file.`
        : "RefHaven could not verify single-file stash recovery state. Stash This File will remain fail-closed until the state can be inspected.",
      ...(pending.length > 0 ? ["Review Recovery Data"] : []),
    );
    const firstRecovery = pending[0];
    if (selection === "Review Recovery Data" && firstRecovery) {
      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(firstRecovery.directory),
      );
    }
  }

  public async refresh(): Promise<void> {
    await this.refreshRepositories();
  }

  private async refreshRepositories(): Promise<RepositoryIdentity[]> {
    const repositories = await discoverRepositories();
    this.treeProvider.setRepositories(repositories);
    this.logger.info("Refreshed stashes", {
      operation: "refreshStashes",
      repositoryCount: repositories.length,
    });
    return repositories;
  }

  public async copyStashMessage(stash: StashEntry): Promise<void> {
    await vscode.env.clipboard.writeText(stash.message);
    showTransientSuccess("Stash message copied");
  }

  public async copyStashSha(stash: StashEntry): Promise<void> {
    await vscode.env.clipboard.writeText(stash.sha);
    showTransientSuccess("Stash SHA copied");
  }

  public async changeFilter(): Promise<void> {
    const filter = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "Message, branch, selector, or SHA",
      prompt: "Leave empty to show every stash",
      title: "RefHaven: Filter Stashes",
      value: this.treeProvider.getFilter(),
      validateInput: (value) =>
        value.length > MAX_INTERACTIVE_INPUT_LENGTH ? "Filter is too long." : undefined,
    });
    if (filter === undefined) return;
    this.treeProvider.setFilter(filter);
  }

  public async stashFile(repositoryRoot: string, filePath: string, message: string): Promise<void> {
    let result: Awaited<ReturnType<typeof stashTrackedFile>>;
    try {
      result = await vscode.window.withProgress(
        {
          cancellable: false,
          location: vscode.ProgressLocation.Notification,
          title: `RefHaven: Stashing ${filePath}`,
        },
        () => stashTrackedFile(repositoryRoot, filePath, message),
      );
    } catch (error) {
      if (!(error instanceof StashCleanupIncompleteError)) throw error;
      await this.refreshAfterStash();
      this.logger.warn("Created stash but stopped cleanup to preserve concurrent changes", {
        operation: "stashFileCleanup",
        phase: error.phase,
      });
      const selection = await vscode.window.showErrorMessage(
        `${error.message} Stash ${error.stashSha.slice(0, 8)} was created.`,
        "Review Safety Copy",
      );
      if (selection === "Review Safety Copy") {
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(error.safetyCopyDirectory),
        );
      }
      return;
    }
    await this.refreshAfterStash();
    this.logger.info("Created path-limited stash", {
      operation: "stashFile",
    });
    if (result.safetyCopyDirectory) {
      const selection = await vscode.window.showInformationMessage(
        `Stashed tracked changes for ${filePath} (${result.stashSha.slice(0, 8)}). A fail-safe copy was retained in Git metadata.`,
        "Review Safety Copy",
      );
      if (selection === "Review Safety Copy") {
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(result.safetyCopyDirectory),
        );
      }
      return;
    }
    void vscode.window.showInformationMessage(
      `Stashed tracked changes for ${filePath} (${result.stashSha.slice(0, 8)}).`,
    );
  }

  private async refreshAfterStash(): Promise<void> {
    const refreshResults = await Promise.allSettled([
      this.refresh(),
      vscode.commands.executeCommand("git.refresh"),
    ]);
    if (refreshResults.some(({ status }) => status === "rejected")) {
      this.logger.warn("Post-stash refresh was incomplete", {
        operation: "stashFileRefresh",
      });
    }
  }
}
