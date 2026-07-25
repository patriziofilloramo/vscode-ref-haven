import * as vscode from "vscode";

import { BlameController } from "./application/BlameController";
import { ComparisonController } from "./application/ComparisonController";
import { ComparisonStore } from "./application/ComparisonStore";
import { RepositoryWatcher } from "./application/RepositoryWatcher";
import { StashController } from "./application/StashController";
import {
  discoverRepositories,
  listChangedFiles,
  listCommitFileChanges,
  listStashes,
} from "./infrastructure/git/GitCli";
import { OutputChannelLogger } from "./infrastructure/logging/OutputChannelLogger";
import { registerCommands } from "./ui/commands/registerCommands";
import {
  GitRevisionContentProvider,
  REVISION_DOCUMENT_SCHEME,
} from "./ui/documents/GitRevisionContentProvider";
import { ChangeDecorationProvider } from "./ui/tree/ChangeDecorationProvider";
import { COMPARISON_VIEW_ID, ComparisonTreeProvider } from "./ui/tree/ComparisonTreeProvider";
import { STASH_VIEW_ID, StashTreeProvider } from "./ui/tree/StashTreeProvider";

export function createCompositionRoot(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Branch Compare");
  const logger = new OutputChannelLogger(outputChannel);
  const store = new ComparisonStore(context.workspaceState);
  const treeProvider = new ComparisonTreeProvider();
  const stashTreeProvider = new StashTreeProvider();
  const revisionProvider = new GitRevisionContentProvider();
  const treeView = vscode.window.createTreeView(COMPARISON_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: treeProvider,
  });
  const stashTreeView = vscode.window.createTreeView(STASH_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: stashTreeProvider,
  });
  const controller = new ComparisonController(
    context,
    store,
    treeProvider,
    logger,
    revisionProvider,
  );
  const stashController = new StashController(stashTreeProvider, logger);
  const blameController = new BlameController(logger);
  const repositoryWatcher = new RepositoryWatcher(() => {
    controller.refreshAll();
    void stashController.refresh().catch((error: unknown) => {
      logger.error("Automatic stash refresh failed", {
        message: error instanceof Error ? error.message : String(error),
        operation: "refreshStashes",
      });
    });
    blameController.refresh();
  });
  const watchWorkspaceRepositories = async (): Promise<void> => {
    const repositories = await discoverRepositories();
    await repositoryWatcher.setRepositories(repositories);
  };
  const scheduleRepositoryWatchRefresh = (): void => {
    void watchWorkspaceRepositories().catch((error: unknown) => {
      logger.error("Repository watcher setup failed", {
        message: error instanceof Error ? error.message : String(error),
        operation: "watchRepositories",
      });
    });
  };
  const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    scheduleRepositoryWatchRefresh();
    void stashController.refresh().catch((error: unknown) => {
      logger.error("Workspace stash refresh failed", {
        message: error instanceof Error ? error.message : String(error),
        operation: "refreshStashes",
      });
    });
  });
  const revisionProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(
    REVISION_DOCUMENT_SCHEME,
    revisionProvider,
  );
  const decorationProviderRegistration = vscode.window.registerFileDecorationProvider(
    new ChangeDecorationProvider(),
  );
  treeProvider.setComparisonLoader((comparison, signal) =>
    controller.calculateComparison(comparison, signal),
  );
  treeProvider.setCommitFilesLoader((repositoryRoot, sha, signal) =>
    listCommitFileChanges(repositoryRoot, sha, signal),
  );
  stashTreeProvider.setLoaders(
    (repositoryRoot, signal) => listStashes(repositoryRoot, signal),
    (repositoryRoot, fromSha, toSha, signal) =>
      listChangedFiles(repositoryRoot, fromSha, toSha, signal),
  );

  context.subscriptions.push(
    logger,
    revisionProviderRegistration,
    revisionProvider,
    decorationProviderRegistration,
    treeProvider,
    stashTreeProvider,
    treeView,
    stashTreeView,
    blameController,
    repositoryWatcher,
    workspaceFoldersListener,
  );
  controller.initialize();
  void stashController.initialize().catch((error: unknown) => {
    logger.error("Initial stash refresh failed", {
      message: error instanceof Error ? error.message : String(error),
      operation: "refreshStashes",
    });
  });
  scheduleRepositoryWatchRefresh();
  registerCommands(context, logger, controller, stashController, blameController);
  logger.info("Extension services registered", { operation: "activate" });
}
