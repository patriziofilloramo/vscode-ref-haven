import type * as vscode from "vscode";

import { createCompositionRoot } from "./compositionRoot";

export function activate(context: vscode.ExtensionContext): void {
  createCompositionRoot(context);
}

export function deactivate(): void {
  // Resources are owned by ExtensionContext.subscriptions and disposed by VS Code.
}
