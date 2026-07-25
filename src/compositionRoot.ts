import * as vscode from "vscode";

import { OutputChannelLogger } from "./infrastructure/logging/OutputChannelLogger";
import { registerCommands } from "./ui/commands/registerCommands";
import { COMPARISON_VIEW_ID, ComparisonTreeProvider } from "./ui/tree/ComparisonTreeProvider";

export function createCompositionRoot(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Branch Compare");
  const logger = new OutputChannelLogger(outputChannel);
  const treeProvider = new ComparisonTreeProvider();
  const treeView = vscode.window.createTreeView(COMPARISON_VIEW_ID, {
    showCollapseAll: false,
    treeDataProvider: treeProvider,
  });

  context.subscriptions.push(logger, treeView);
  registerCommands(context, logger);
  logger.info("Extension services registered", { operation: "activate" });
}
