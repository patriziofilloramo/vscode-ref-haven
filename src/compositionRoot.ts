import * as vscode from "vscode";

import { BlameController } from "./application/BlameController";
import { CommitDetailsController } from "./application/CommitDetailsController";
import { ComparisonController } from "./application/ComparisonController";
import { ComparisonStore } from "./application/ComparisonStore";
import { FileHistoryController } from "./application/FileHistoryController";
import { FileAnnotationsController } from "./application/FileAnnotationsController";
import { FileActionsController } from "./application/FileActionsController";
import { LineHoverController } from "./application/LineHoverController";
import { RepositoryWatcher } from "./application/RepositoryWatcher";
import { RepositoryNavigationController } from "./application/RepositoryNavigationController";
import { StashController } from "./application/StashController";
import {
  discoverRepositories,
  listFileHistory,
  listChangedFiles,
  listCommitFileChanges,
  listStashes,
  readCommitDetails,
} from "./infrastructure/git/GitCli";
import { OutputChannelLogger } from "./infrastructure/logging/OutputChannelLogger";
import { registerCommands } from "./ui/commands/registerCommands";
import { LineHoverProvider } from "./ui/blame/LineHoverProvider";
import {
  GitRevisionContentProvider,
  REVISION_DOCUMENT_SCHEME,
} from "./ui/documents/GitRevisionContentProvider";
import { ChangeDecorationProvider } from "./ui/tree/ChangeDecorationProvider";
import { BRANCHES_VIEW_ID, BranchesTreeProvider } from "./ui/tree/BranchesTreeProvider";
import {
  COMMIT_DETAILS_VIEW_ID,
  CommitDetailsTreeProvider,
} from "./ui/tree/CommitDetailsTreeProvider";
import { COMPARISON_VIEW_ID, ComparisonTreeProvider } from "./ui/tree/ComparisonTreeProvider";
import { FILE_HISTORY_VIEW_ID, FileHistoryTreeProvider } from "./ui/tree/FileHistoryTreeProvider";
import { STASH_VIEW_ID, StashTreeProvider } from "./ui/tree/StashTreeProvider";
import { WORKTREES_VIEW_ID, WorktreesTreeProvider } from "./ui/tree/WorktreesTreeProvider";

export function createCompositionRoot(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("RefHaven");
  const logger = new OutputChannelLogger(outputChannel);
  const store = new ComparisonStore(context.workspaceState);
  const commitDetailsTreeProvider = new CommitDetailsTreeProvider();
  const branchesTreeProvider = new BranchesTreeProvider();
  const treeProvider = new ComparisonTreeProvider();
  const fileHistoryTreeProvider = new FileHistoryTreeProvider();
  const stashTreeProvider = new StashTreeProvider();
  const worktreesTreeProvider = new WorktreesTreeProvider();
  const revisionProvider = new GitRevisionContentProvider();
  const treeView = vscode.window.createTreeView(COMPARISON_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: treeProvider,
  });
  const stashTreeView = vscode.window.createTreeView(STASH_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: stashTreeProvider,
  });
  const fileHistoryTreeView = vscode.window.createTreeView(FILE_HISTORY_VIEW_ID, {
    treeDataProvider: fileHistoryTreeProvider,
  });
  const commitDetailsTreeView = vscode.window.createTreeView(COMMIT_DETAILS_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: commitDetailsTreeProvider,
  });
  const branchesTreeView = vscode.window.createTreeView(BRANCHES_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: branchesTreeProvider,
  });
  const worktreesTreeView = vscode.window.createTreeView(WORKTREES_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: worktreesTreeProvider,
  });
  const controller = new ComparisonController(
    context,
    store,
    treeProvider,
    treeView,
    logger,
    revisionProvider,
  );
  const stashController = new StashController(stashTreeProvider, logger);
  const repositoryNavigationController = new RepositoryNavigationController(
    branchesTreeProvider,
    worktreesTreeProvider,
    controller,
    logger,
  );
  repositoryNavigationController.installLoaders();
  const commitDetailsController = new CommitDetailsController(
    commitDetailsTreeProvider,
    commitDetailsTreeView,
    logger,
  );
  const fileHistoryController = new FileHistoryController(
    fileHistoryTreeProvider,
    fileHistoryTreeView,
    controller,
    logger,
  );
  const blameController = new BlameController(logger);
  const lineHoverController = new LineHoverController(logger);
  const lineHoverProvider = new LineHoverProvider(lineHoverController, logger);
  const fileAnnotationsController = new FileAnnotationsController(logger);
  const fileActionsController = new FileActionsController(
    controller,
    fileAnnotationsController,
    fileHistoryController,
    logger,
  );
  const repositoryWatcher = new RepositoryWatcher(() => {
    controller.refreshAll();
    void repositoryNavigationController.refresh().catch((error: unknown) => {
      logger.error("Automatic repository navigation refresh failed", {
        message: error instanceof Error ? error.message : String(error),
        operation: "refreshRepositoryNavigation",
      });
    });
    void stashController.refresh().catch((error: unknown) => {
      logger.error("Automatic stash refresh failed", {
        message: error instanceof Error ? error.message : String(error),
        operation: "refreshStashes",
      });
    });
    blameController.refresh();
    lineHoverController.refresh();
    fileAnnotationsController.refresh();
    void fileHistoryController.refresh(true).catch((error: unknown) => {
      logger.error("Automatic file history refresh failed", {
        message: error instanceof Error ? error.message : String(error),
        operation: "refreshFileHistory",
      });
    });
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
    void repositoryNavigationController.refresh().catch((error: unknown) => {
      logger.error("Workspace repository navigation refresh failed", {
        message: error instanceof Error ? error.message : String(error),
        operation: "refreshRepositoryNavigation",
      });
    });
  });
  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
    void fileHistoryController.refresh().catch((error: unknown) => {
      logger.error("Active file history refresh failed", {
        message: error instanceof Error ? error.message : String(error),
        operation: "refreshFileHistory",
      });
    });
  });
  const savedDocumentListener = vscode.workspace.onDidSaveTextDocument((document) => {
    if (document === vscode.window.activeTextEditor?.document) {
      void fileHistoryController.refresh(true).catch((error: unknown) => {
        logger.error("Saved file history refresh failed", {
          message: error instanceof Error ? error.message : String(error),
          operation: "refreshFileHistory",
        });
      });
    }
  });
  const revisionProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(
    REVISION_DOCUMENT_SCHEME,
    revisionProvider,
  );
  const decorationProviderRegistration = vscode.window.registerFileDecorationProvider(
    new ChangeDecorationProvider(),
  );
  const lineHoverProviderRegistration = vscode.languages.registerHoverProvider(
    { scheme: "file" },
    lineHoverProvider,
  );
  treeProvider.setComparisonLoader((comparison, signal) =>
    controller.calculateComparison(comparison, signal),
  );
  treeProvider.setCommitFilesLoader((repositoryRoot, sha, signal) =>
    listCommitFileChanges(repositoryRoot, sha, signal),
  );
  fileHistoryTreeProvider.setLoader((repositoryRoot, filePath, signal) =>
    listFileHistory(repositoryRoot, filePath, undefined, signal),
  );
  commitDetailsTreeProvider.setLoaders(
    (repositoryRoot, sha, signal) => readCommitDetails(repositoryRoot, sha, signal),
    (repositoryRoot, sha, signal) => listCommitFileChanges(repositoryRoot, sha, signal),
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
    lineHoverProviderRegistration,
    branchesTreeProvider,
    commitDetailsTreeProvider,
    treeProvider,
    fileHistoryTreeProvider,
    stashTreeProvider,
    worktreesTreeProvider,
    branchesTreeView,
    commitDetailsTreeView,
    treeView,
    fileHistoryTreeView,
    stashTreeView,
    worktreesTreeView,
    blameController,
    fileAnnotationsController,
    fileHistoryController,
    repositoryWatcher,
    workspaceFoldersListener,
    activeEditorListener,
    savedDocumentListener,
  );
  controller.initialize();
  void stashController.initialize().catch((error: unknown) => {
    logger.error("Initial stash refresh failed", {
      message: error instanceof Error ? error.message : String(error),
      operation: "refreshStashes",
    });
  });
  void repositoryNavigationController.initialize().catch((error: unknown) => {
    logger.error("Initial repository navigation refresh failed", {
      message: error instanceof Error ? error.message : String(error),
      operation: "refreshRepositoryNavigation",
    });
  });
  scheduleRepositoryWatchRefresh();
  void fileHistoryController.refresh().catch((error: unknown) => {
    logger.error("Initial file history refresh failed", {
      message: error instanceof Error ? error.message : String(error),
      operation: "refreshFileHistory",
    });
  });
  registerCommands(
    context,
    logger,
    controller,
    repositoryNavigationController,
    fileActionsController,
    commitDetailsController,
    fileHistoryController,
    stashController,
    blameController,
  );
  logger.info("Extension services registered", { operation: "activate" });
}
