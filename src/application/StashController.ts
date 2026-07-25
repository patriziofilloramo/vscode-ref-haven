import * as vscode from "vscode";

import type { Logger } from "./Logger";
import { shortSha } from "../domain/comparisonResult";
import type { StashEntry } from "../domain/stash";
import {
  applyStash,
  discoverRepositories,
  dropStash,
  popStash,
  pushStash,
  resolveRef,
} from "../infrastructure/git/GitCli";
import { pickRepository } from "../ui/pickers/comparisonPickers";
import type { StashNode, StashTreeProvider } from "../ui/tree/StashTreeProvider";

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

  public async applyStash(node: StashNode): Promise<void> {
    try {
      await this.verifySelector(node);
      await applyStash(node.repository.rootPath, node.stash.selector);
      void vscode.window.showInformationMessage(`Applied stash: ${node.stash.message}`);
      this.logger.info("Applied stash", { operation: "applyStash" });
    } finally {
      await this.refresh();
    }
  }

  public async popStash(node: StashNode): Promise<void> {
    try {
      await this.verifySelector(node);
      await popStash(node.repository.rootPath, node.stash.selector);
      void vscode.window.showInformationMessage(`Popped stash: ${node.stash.message}`);
      this.logger.info("Popped stash", { operation: "popStash" });
    } finally {
      await this.refresh();
    }
  }

  public async dropStash(node: StashNode): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Drop stash "${node.stash.message}" (${node.stash.selector})?`,
      { detail: "The stashed changes cannot be recovered afterwards.", modal: true },
      "Drop Stash",
    );
    if (confirmed !== "Drop Stash") return;

    try {
      await this.verifySelector(node);
      await dropStash(node.repository.rootPath, node.stash.selector);
      void vscode.window.showInformationMessage(`Dropped stash: ${node.stash.message}`);
      this.logger.info("Dropped stash", { operation: "dropStash" });
    } finally {
      await this.refresh();
    }
  }

  public async stashAllChanges(): Promise<void> {
    const repositories = await discoverRepositories();
    if (repositories.length === 0) {
      void vscode.window.showWarningMessage("Open a Git workspace before stashing changes.");
      return;
    }
    const repository = await pickRepository(repositories);
    if (!repository) return;

    const scope = await vscode.window.showQuickPick(
      [
        {
          description: "git stash push --include-untracked",
          includeUntracked: true,
          label: "Stash all changes",
        },
        {
          description: "git stash push",
          includeUntracked: false,
          label: "Stash tracked changes only",
        },
      ],
      { placeHolder: "Select which changes to stash", title: "Branch Compare: Stash All Changes" },
    );
    if (!scope) return;

    const message = await vscode.window.showInputBox({
      placeHolder: "Optional stash message",
      prompt: "Describe the stash (leave empty for Git's default message)",
      title: "Branch Compare: Stash All Changes",
    });
    if (message === undefined) return;

    try {
      const statusLine = await pushStash(
        repository.rootPath,
        message.trim().length > 0 ? message.trim() : null,
        scope.includeUntracked,
      );
      void vscode.window.showInformationMessage(
        statusLine.length > 0 ? statusLine : "Stashed the working tree changes.",
      );
      this.logger.info("Stashed changes", {
        includeUntracked: scope.includeUntracked,
        operation: "stashAllChanges",
      });
    } finally {
      await this.refresh();
    }
  }

  public async copyStashMessage(stash: StashEntry): Promise<void> {
    await vscode.env.clipboard.writeText(stash.message);
    void vscode.window.showInformationMessage("Stash message copied to the clipboard.");
  }

  /** Guards against stale tree entries: selectors shift when stashes change. */
  private async verifySelector(node: StashNode): Promise<void> {
    const resolved = await resolveRef(node.repository.rootPath, node.stash.selector).catch(() => {
      throw new Error("This stash no longer exists. The view has been refreshed.");
    });
    if (resolved !== node.stash.sha) {
      throw new Error(
        `The stash list changed (${node.stash.selector} is now ${shortSha(resolved)}). Try again after the refresh.`,
      );
    }
  }
}
