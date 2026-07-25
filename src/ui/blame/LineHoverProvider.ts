import * as vscode from "vscode";

import type { LineHoverController } from "../../application/LineHoverController";
import type { Logger } from "../../application/Logger";
import { RICH_BLAME_HOVER_COMMANDS, richBlameHoverMarkdown } from "./richBlameHover";

const CONFIG_SECTION = "refhaven";
const LINE_HOVER_SETTING = "lineHover.enabled";

export class LineHoverProvider implements vscode.HoverProvider {
  public constructor(
    private readonly controller: LineHoverController,
    private readonly logger: Logger,
  ) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | null> {
    const enabled = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>(LINE_HOVER_SETTING, true);
    if (!enabled || document.uri.scheme !== "file") return null;

    const abortController = new AbortController();
    const cancellation = token.onCancellationRequested(() => abortController.abort());
    try {
      const data = await this.controller.load(document, position.line, abortController.signal);
      if (!data || token.isCancellationRequested) return null;
      const markdown = new vscode.MarkdownString(richBlameHoverMarkdown(data));
      markdown.supportHtml = false;
      markdown.supportThemeIcons = true;
      markdown.isTrusted = { enabledCommands: [...RICH_BLAME_HOVER_COMMANDS] };
      return new vscode.Hover(markdown, document.lineAt(position.line).range);
    } catch (error) {
      if (!token.isCancellationRequested) {
        this.logger.error("Rich line hover failed", {
          message: error instanceof Error ? error.message : String(error),
          operation: "lineHover",
        });
      }
      return null;
    } finally {
      cancellation.dispose();
    }
  }
}
