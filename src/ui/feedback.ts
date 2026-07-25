import * as vscode from "vscode";

const TRANSIENT_FEEDBACK_DURATION_MS = 2_500;

/** Shows routine success feedback without interrupting the editor workflow. */
export function showTransientSuccess(message: string): void {
  vscode.window.setStatusBarMessage(
    `$(check) RefHaven: ${message}`,
    TRANSIENT_FEEDBACK_DURATION_MS,
  );
}
