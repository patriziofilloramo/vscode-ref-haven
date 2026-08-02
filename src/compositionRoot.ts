import * as vscode from "vscode";

import { BlameController } from "./application/BlameController";
import { LineIntelligenceController } from "./application/LineIntelligenceController";
import { CommitDetailsController } from "./application/CommitDetailsController";
import { ComparisonController } from "./application/ComparisonController";
import { ComparisonReviewStore } from "./application/ComparisonReviewStore";
import { ComparisonStore } from "./application/ComparisonStore";
import { runInBackground } from "./application/errorHandling";
import { FileHistoryController } from "./application/FileHistoryController";
import { FileAnnotationsController } from "./application/FileAnnotationsController";
import { FileActionsController } from "./application/FileActionsController";
import { BrowserLinkController } from "./application/BrowserLinkController";
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
  watchGitRepositories,
} from "./infrastructure/git/GitCli";
import { setGitFilterProbeObserver } from "./infrastructure/git/GitProcess";
import { OutputChannelLogger } from "./infrastructure/logging/OutputChannelLogger";
import { registerCommands } from "./ui/commands/registerCommands";
import { LineHoverProvider } from "./ui/blame/LineHoverProvider";
import {
  GitRevisionContentProvider,
  REVISION_DOCUMENT_SCHEME,
} from "./ui/documents/GitRevisionContentProvider";
import { ChangeDecorationProvider } from "./ui/tree/ChangeDecorationProvider";
import { BranchesTreeProvider } from "./ui/tree/BranchesTreeProvider";
import { CommitDetailsTreeProvider } from "./ui/tree/CommitDetailsTreeProvider";
import { COMPARISON_VIEW_ID, ComparisonTreeProvider } from "./ui/tree/ComparisonTreeProvider";
import { FileHistoryTreeProvider } from "./ui/tree/FileHistoryTreeProvider";
import { INSPECTOR_VIEW_ID, InspectorTreeProvider } from "./ui/tree/InspectorTreeProvider";
import { REPOSITORY_VIEW_ID, RepositoryTreeProvider } from "./ui/tree/RepositoryTreeProvider";
import { STASH_VIEW_ID, StashTreeProvider } from "./ui/tree/StashTreeProvider";
import { WorktreesTreeProvider } from "./ui/tree/WorktreesTreeProvider";

export function createCompositionRoot(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("RefHaven");
  const logger = new OutputChannelLogger(outputChannel);
  setGitFilterProbeObserver(({ durationMs, sharedCommands }) => {
    logger.debug("Probed Git filter configuration", {
      durationMs,
      operation: "gitFilterProbe",
      sharedCommands,
    });
  });
  const store = new ComparisonStore(context.workspaceState);
  const reviewStore = new ComparisonReviewStore(context.workspaceState);
  const commitDetailsTreeProvider = new CommitDetailsTreeProvider();
  const branchesTreeProvider = new BranchesTreeProvider();
  const treeProvider = new ComparisonTreeProvider();
  const fileHistoryTreeProvider = new FileHistoryTreeProvider();
  const stashTreeProvider = new StashTreeProvider();
  const worktreesTreeProvider = new WorktreesTreeProvider();
  const inspectorTreeProvider = new InspectorTreeProvider(
    fileHistoryTreeProvider,
    commitDetailsTreeProvider,
  );
  const repositoryTreeProvider = new RepositoryTreeProvider(
    branchesTreeProvider,
    worktreesTreeProvider,
  );
  const revisionProvider = new GitRevisionContentProvider();
  const treeView = vscode.window.createTreeView(COMPARISON_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: treeProvider,
  });
  const stashTreeView = vscode.window.createTreeView(STASH_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: stashTreeProvider,
  });
  const inspectorTreeView = vscode.window.createTreeView(INSPECTOR_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: inspectorTreeProvider,
  });
  const repositoryTreeView = vscode.window.createTreeView(REPOSITORY_VIEW_ID, {
    canSelectMany: true,
    showCollapseAll: true,
    treeDataProvider: repositoryTreeProvider,
  });
  const controller = new ComparisonController(
    context,
    store,
    treeProvider,
    treeView,
    logger,
    revisionProvider,
    reviewStore,
  );
  const stashController = new StashController(stashTreeProvider, logger);
  const repositoryNavigationController = new RepositoryNavigationController(
    branchesTreeProvider,
    repositoryTreeView,
    worktreesTreeProvider,
    controller,
    logger,
  );
  repositoryNavigationController.installLoaders();
  const commitDetailsController = new CommitDetailsController(
    commitDetailsTreeProvider,
    controller,
    logger,
  );
  const fileHistoryController = new FileHistoryController(
    fileHistoryTreeProvider,
    controller,
    logger,
  );
  const blameController = new BlameController(logger);
  const lineIntelligenceController = new LineIntelligenceController(context, logger);
  const lineHoverController = new LineHoverController(revisionProvider, logger);
  const lineHoverProvider = new LineHoverProvider(lineHoverController, logger);
  const fileAnnotationsController = new FileAnnotationsController(logger);
  const gitLabController = new BrowserLinkController(logger);
  const fileActionsController = new FileActionsController(
    controller,
    fileAnnotationsController,
    fileHistoryController,
    stashController,
    logger,
  );
  const repositoryWatcher = new RepositoryWatcher(() => {
    controller.refreshAll();
    runInBackground(
      repositoryNavigationController.refresh(),
      logger,
      "Automatic repository navigation refresh failed",
      "refreshRepositoryNavigation",
    );
    runInBackground(
      stashController.refresh(),
      logger,
      "Automatic stash refresh failed",
      "refreshStashes",
    );
    blameController.refresh();
    lineHoverController.refresh();
    fileAnnotationsController.refresh();
    runInBackground(
      fileHistoryController.refresh(true),
      logger,
      "Automatic file history refresh failed",
      "refreshFileHistory",
    );
  });
  const watchWorkspaceRepositories = async (): Promise<void> => {
    const repositories = await discoverRepositories();
    await repositoryWatcher.setRepositories(repositories);
  };
  const scheduleRepositoryWatchRefresh = (): void => {
    runInBackground(
      watchWorkspaceRepositories(),
      logger,
      "Repository watcher setup failed",
      "watchRepositories",
    );
  };
  const scheduleRepositoryTopologyRefresh = (clearComparisonsBeforeDiscovery: boolean): void => {
    runInBackground(
      controller.refreshAvailableComparisons(clearComparisonsBeforeDiscovery),
      logger,
      "Workspace comparison refresh failed",
      "refreshAvailableComparisons",
    );
    scheduleRepositoryWatchRefresh();
    runInBackground(
      stashController.refresh(),
      logger,
      "Workspace stash refresh failed",
      "refreshStashes",
    );
    runInBackground(
      repositoryNavigationController.refresh(),
      logger,
      "Workspace repository navigation refresh failed",
      "refreshRepositoryNavigation",
    );
  };
  const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    scheduleRepositoryTopologyRefresh(true);
  });
  const gitRepositoriesListener = watchGitRepositories(() => {
    scheduleRepositoryTopologyRefresh(false);
  });
  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
    runInBackground(
      fileHistoryController.refresh(),
      logger,
      "Active file history refresh failed",
      "refreshFileHistory",
    );
  });
  const savedDocumentListener = vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.uri.scheme === "file") controller.refreshWorkingTreeComparisons();
    if (document === vscode.window.activeTextEditor?.document) {
      runInBackground(
        fileHistoryController.refresh(true),
        logger,
        "Saved file history refresh failed",
        "refreshFileHistory",
      );
    }
  });
  const workspaceFileOperationListeners = vscode.Disposable.from(
    vscode.workspace.onDidCreateFiles(() => controller.refreshWorkingTreeComparisons()),
    vscode.workspace.onDidDeleteFiles(() => controller.refreshWorkingTreeComparisons()),
    vscode.workspace.onDidRenameFiles(() => controller.refreshWorkingTreeComparisons()),
  );
  const windowFocusListener = vscode.window.onDidChangeWindowState(({ focused }) => {
    if (focused) {
      controller.refreshWorkingTreeComparisons();
      scheduleRepositoryTopologyRefresh(false);
    }
  });
  const comparisonVisibilityListener = treeView.onDidChangeVisibility(({ visible }) => {
    if (visible) {
      controller.refreshWorkingTreeComparisons();
      scheduleRepositoryTopologyRefresh(false);
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
    [{ scheme: "file" }, { scheme: REVISION_DOCUMENT_SCHEME }],
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
    new vscode.Disposable(() => {
      setGitFilterProbeObserver();
    }),
    logger,
    revisionProviderRegistration,
    revisionProvider,
    decorationProviderRegistration,
    lineHoverProviderRegistration,
    branchesTreeProvider,
    commitDetailsTreeProvider,
    inspectorTreeProvider,
    repositoryTreeProvider,
    treeProvider,
    fileHistoryTreeProvider,
    stashTreeProvider,
    worktreesTreeProvider,
    inspectorTreeView,
    treeView,
    repositoryTreeView,
    stashTreeView,
    blameController,
    fileAnnotationsController,
    fileHistoryController,
    repositoryWatcher,
    workspaceFoldersListener,
    gitRepositoriesListener,
    activeEditorListener,
    savedDocumentListener,
    workspaceFileOperationListeners,
    windowFocusListener,
    comparisonVisibilityListener,
  );
  controller.initialize();
  runInBackground(
    controller.refreshAvailableComparisons(),
    logger,
    "Initial comparison workspace refresh failed",
    "refreshAvailableComparisons",
  );
  runInBackground(
    stashController.initialize(),
    logger,
    "Initial stash refresh failed",
    "refreshStashes",
  );
  runInBackground(
    repositoryNavigationController.initialize(),
    logger,
    "Initial repository navigation refresh failed",
    "refreshRepositoryNavigation",
  );
  scheduleRepositoryWatchRefresh();
  runInBackground(
    fileHistoryController.refresh(),
    logger,
    "Initial file history refresh failed",
    "refreshFileHistory",
  );
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
    gitLabController,
    lineIntelligenceController,
  );
  // Raised when the user can actually see the overlap — the first time inline
  // blame is drawn on a line — rather than at activation, where it would
  // describe something not yet on screen.
  blameController.setFirstInlineRenderListener(() => {
    runInBackground(
      lineIntelligenceController.noticeOverlapOnce(),
      logger,
      "Line intelligence overlap notice failed",
      "lineIntelligence",
    );
  });
  logger.info("Extension services registered", { operation: "activate" });
}
