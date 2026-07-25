import * as vscode from "vscode";

import type { Logger } from "./Logger";
import type { StashEntry } from "../domain/stash";
import { discoverRepositories } from "../infrastructure/git/GitCli";
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
}
