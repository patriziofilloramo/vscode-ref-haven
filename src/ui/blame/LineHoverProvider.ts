import * as vscode from "vscode";

import {
  EXTENSION_SETTING_DEFAULTS,
  EXTENSION_SETTINGS,
  readExtensionSetting,
} from "../../config/extensionConfiguration";
import { errorLogMetadata } from "../../application/errorHandling";
import type { LineHoverController } from "../../application/LineHoverController";
import type { Logger } from "../../application/Logger";
import { REVISION_DOCUMENT_SCHEME } from "../documents/GitRevisionContentProvider";
import { RICH_BLAME_HOVER_COMMANDS, richBlameHoverMarkdown } from "./richBlameHover";

const HOVER_SCHEMES: readonly string[] = ["file", REVISION_DOCUMENT_SCHEME];

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
    const enabled = readExtensionSetting<boolean>(
      EXTENSION_SETTINGS.lineHoverEnabled,
      EXTENSION_SETTING_DEFAULTS.lineHoverEnabled,
    );
    if (!enabled || !HOVER_SCHEMES.includes(document.uri.scheme)) return null;

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
        this.logger.error("Rich line hover failed", errorLogMetadata(error, "lineHover"));
      }
      return null;
    } finally {
      cancellation.dispose();
    }
  }
}
