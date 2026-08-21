import * as vscode from "vscode";

export interface FileDiffRevealRange {
  readonly lineCount: number;
  readonly startLine: number;
}

export function historyDiffSelection(range: FileDiffRevealRange): vscode.Range {
  if (
    !Number.isInteger(range.startLine) ||
    !Number.isInteger(range.lineCount) ||
    range.startLine < 0 ||
    range.lineCount < 0
  ) {
    throw new Error("The line-history diff range is invalid.");
  }
  const startLine = Math.max(range.startLine - 1, 0);
  const endLine = startLine + Math.max(range.lineCount - 1, 0);
  return new vscode.Range(startLine, 0, endLine, 0);
}

export function revealHistoryDiffRange(uri: vscode.Uri, requested: vscode.Range): void {
  const editor = vscode.window.visibleTextEditors.find(
    ({ document }) => document.uri.toString() === uri.toString(),
  );
  if (!editor) return;
  const lastLine = Math.max(editor.document.lineCount - 1, 0);
  const start = new vscode.Position(Math.min(requested.start.line, lastLine), 0);
  const end = new vscode.Position(Math.min(Math.max(requested.end.line, start.line), lastLine), 0);
  const range = new vscode.Range(start, end);
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}
