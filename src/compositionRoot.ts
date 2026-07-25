import * as vscode from "vscode";

import { ComparisonController } from "./application/ComparisonController";
import { OutputChannelLogger } from "./infrastructure/logging/OutputChannelLogger";
import { registerCommands } from "./ui/commands/registerCommands";
import {
  GitRevisionContentProvider,
  REVISION_DOCUMENT_SCHEME,
} from "./ui/documents/GitRevisionContentProvider";
import { COMPARISON_VIEW_ID, ComparisonTreeProvider } from "./ui/tree/ComparisonTreeProvider";

export function createCompositionRoot(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Branch Compare");
  const logger = new OutputChannelLogger(outputChannel);
  const treeProvider = new ComparisonTreeProvider();
  const revisionProvider = new GitRevisionContentProvider();
  const treeView = vscode.window.createTreeView(COMPARISON_VIEW_ID, {
    showCollapseAll: true,
    treeDataProvider: treeProvider,
  });
  const controller = new ComparisonController(context, treeProvider, logger, revisionProvider);
  const revisionProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(
    REVISION_DOCUMENT_SCHEME,
    revisionProvider,
  );
  treeProvider.setComparisonLoader((comparison) => controller.calculateComparison(comparison));

  context.subscriptions.push(logger, revisionProviderRegistration, treeView);
  controller.initialize();
  registerCommands(context, logger, controller);
  logger.info("Extension services registered", { operation: "activate" });
}
