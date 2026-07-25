import * as vscode from "vscode";

import type { Logger } from "./Logger";
import type { StashEntry } from "../domain/stash";
import { discoverRepositories, stashTrackedFile } from "../infrastructure/git/GitCli";
import type { StashTreeProvider } from "../ui/tree/StashTreeProvider";

export class StashController {
  public constructor(
    private readonly treeProvider: StashTreeProvider,
    private readonly logger: Logger,
  ) {}

  public async initialize(): Promise<void> {
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    const repositories = await discoverRepositories();
    this.treeProvider.setRepositories(repositories);
    this.logger.info("Refreshed stashes", {
      operation: "refreshStashes",
      repositoryCount: repositories.length,
    });
  }

  public async copyStashMessage(stash: StashEntry): Promise<void> {
    await vscode.env.clipboard.writeText(stash.message);
    void vscode.window.showInformationMessage("Stash message copied to the clipboard.");
  }

  public async copyStashSha(stash: StashEntry): Promise<void> {
    await vscode.env.clipboard.writeText(stash.sha);
    void vscode.window.showInformationMessage("Stash SHA copied to the clipboard.");
  }

  public async changeFilter(): Promise<void> {
    const filter = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      placeHolder: "Message, branch, selector, or SHA",
      prompt: "Leave empty to show every stash",
      title: "RefHaven: Filter Stashes",
      value: this.treeProvider.getFilter(),
      validateInput: (value) => (value.length > 256 ? "Filter is too long." : undefined),
    });
    if (filter === undefined) return;
    this.treeProvider.setFilter(filter);
  }

  public async stashFile(repositoryRoot: string, filePath: string, message: string): Promise<void> {
    const stashSha = await vscode.window.withProgress(
      {
        cancellable: false,
        location: vscode.ProgressLocation.Notification,
        title: `RefHaven: Stashing ${filePath}`,
      },
      () => stashTrackedFile(repositoryRoot, filePath, message),
    );
    const refreshResults = await Promise.allSettled([
      this.refresh(),
      vscode.commands.executeCommand("git.refresh"),
    ]);
    if (refreshResults.some(({ status }) => status === "rejected")) {
      this.logger.warn("Post-stash refresh was incomplete", {
        operation: "stashFileRefresh",
      });
    }
    this.logger.info("Created path-limited stash", {
      operation: "stashFile",
    });
    void vscode.window.showInformationMessage(
      `Stashed tracked changes for ${filePath} (${stashSha.slice(0, 8)}).`,
    );
  }
}
