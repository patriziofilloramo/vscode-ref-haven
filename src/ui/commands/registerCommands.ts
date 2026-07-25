import * as vscode from "vscode";

import type { ComparisonController } from "../../application/ComparisonController";
import type { Logger } from "../../application/Logger";
import { COMMAND_IDS, type CommandId } from "./commandIds";

interface CommandDefinition {
  readonly id: CommandId;
  readonly operation: string;
}

const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  { id: COMMAND_IDS.newComparison, operation: "newComparison" },
  { id: COMMAND_IDS.compareCurrentBranch, operation: "compareCurrentBranch" },
  { id: COMMAND_IDS.openFileDiff, operation: "openFileDiff" },
  { id: COMMAND_IDS.refreshAll, operation: "refreshAll" },
];

export function registerCommands(
  context: vscode.ExtensionContext,
  logger: Logger,
  controller: ComparisonController,
): void {
  for (const definition of COMMAND_DEFINITIONS) {
    const disposable = vscode.commands.registerCommand(
      definition.id,
      async (...args: unknown[]) => {
        logger.info("Command invoked", { operation: definition.operation });
        try {
          await executeCommand(definition.id, controller, args);
        } catch (error) {
          logger.error("Command failed", {
            message: error instanceof Error ? error.message : String(error),
            operation: definition.operation,
          });
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : "Branch Compare command failed.",
          );
        }
      },
    );

    context.subscriptions.push(disposable);
  }
}

async function executeCommand(
  commandId: CommandId,
  controller: ComparisonController,
  args: readonly unknown[],
): Promise<void> {
  switch (commandId) {
    case COMMAND_IDS.newComparison:
      await controller.newComparison();
      break;
    case COMMAND_IDS.compareCurrentBranch:
      await controller.compareCurrentBranch();
      break;
    case COMMAND_IDS.openFileDiff:
      await controller.openFileDiff(
        args[0] as Parameters<ComparisonController["openFileDiff"]>[0],
        args[1] as Parameters<ComparisonController["openFileDiff"]>[1],
      );
      break;
    case COMMAND_IDS.refreshAll:
      controller.refreshAll();
      break;
  }
}
