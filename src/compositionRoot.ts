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
    void stashController.refresh();
    blameController.refresh();
  });
  const watchWorkspaceRepositories = (): void => {
    void discoverRepositories().then((repositories) => {
      repositoryWatcher.setRepositories(repositories);
    });
  };
  const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    watchWorkspaceRepositories();
    void stashController.refresh();
  });
  const revisionProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(
    REVISION_DOCUMENT_SCHEME,
    revisionProvider,
  );
  const decorationProviderRegistration = vscode.window.registerFileDecorationProvider(
    new ChangeDecorationProvider(),
  );
  treeProvider.setComparisonLoader((comparison) => controller.calculateComparison(comparison));
  treeProvider.setCommitFilesLoader((repositoryRoot, sha) =>
    listCommitFileChanges(repositoryRoot, sha),
  );
  stashTreeProvider.setLoaders(
    (repositoryRoot) => listStashes(repositoryRoot),
    (repositoryRoot, fromSha, toSha) => listChangedFiles(repositoryRoot, fromSha, toSha),
  );

  context.subscriptions.push(
    logger,
    revisionProviderRegistration,
    decorationProviderRegistration,
    treeView,
    stashTreeView,
    blameController,
    repositoryWatcher,
    workspaceFoldersListener,
  );
  controller.initialize();
  void stashController.initialize();
  watchWorkspaceRepositories();
  registerCommands(context, logger, controller, stashController, blameController);
  logger.info("Extension services registered", { operation: "activate" });
}
