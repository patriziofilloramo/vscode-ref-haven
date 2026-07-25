import * as vscode from "vscode";

import type { Logger } from "../../application/Logger";
import { COMMAND_IDS, type CommandId } from "./commandIds";

interface CommandDefinition {
  readonly id: CommandId;
  readonly operation: string;
}

const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  { id: COMMAND_IDS.newComparison, operation: "newComparison" },
  { id: COMMAND_IDS.compareCurrentBranch, operation: "compareCurrentBranch" },
  { id: COMMAND_IDS.refreshAll, operation: "refreshAll" },
];

export function registerCommands(context: vscode.ExtensionContext, logger: Logger): void {
  for (const definition of COMMAND_DEFINITIONS) {
    const disposable = vscode.commands.registerCommand(definition.id, () => {
      logger.info("Command invoked", { operation: definition.operation });
    });

    context.subscriptions.push(disposable);
  }
}
