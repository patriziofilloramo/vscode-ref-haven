import * as vscode from "vscode";

import {
  EXTENSION_CONFIGURATION_SECTION,
  EXTENSION_SETTING_DEFAULTS,
  EXTENSION_SETTINGS,
  getExtensionConfiguration,
  readExtensionSetting,
} from "../config/extensionConfiguration";
import type { Logger } from "./Logger";
import { runInBackground } from "./errorHandling";
import type { LineBlame } from "../domain/blame";
import { shortSha } from "../domain/comparisonResult";
import {
  blameLine,
  readGitUserName,
  resolveWorkspaceRepositoryFile,
  type WorkspaceRepositoryFile,
} from "../infrastructure/git/GitCli";
import {
  BLAME_HOVER_COMMANDS,
  blameCommitInfo,
  blameHoverMarkdown,
  inlineBlameText,
  statusBarBlameText,
} from "../ui/blame/blamePresentation";
import { COMMAND_IDS } from "../ui/commands/commandIds";

const UPDATE_DEBOUNCE_MS = 250;

interface CurrentLineBlame {
  readonly blame: LineBlame;
  readonly relativePath: string;
  readonly repositoryRootPath: string;
}

/** Shows blame for the cursor's line as inline text and a status bar entry. */
export class BlameController implements vscode.Disposable {
  private current: CurrentLineBlame | undefined;
  private inlineRenderReported = false;
  private onFirstInlineRender: (() => void) | undefined;
  private activeUpdate: AbortController | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      margin: "0 0 0 3em",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly disposables: vscode.Disposable[] = [];
  private generation = 0;
  private readonly repositoryFiles = new Map<string, WorkspaceRepositoryFile>();
  private readonly statusBarItem: vscode.StatusBarItem;
  private updateTimer: NodeJS.Timeout | undefined;
  private readonly userNames = new Map<string, Promise<string | null>>();

  public constructor(private readonly logger: Logger) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      "refhaven.lineBlame",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.name = "RefHaven Line Blame";
    this.statusBarItem.command = COMMAND_IDS.showLineBlameActions;

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleUpdate()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) this.scheduleUpdate();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) this.scheduleUpdate();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(EXTENSION_CONFIGURATION_SECTION)) this.scheduleUpdate();
      }),
    );
    this.scheduleUpdate();
  }

  public dispose(): void {
    this.activeUpdate?.abort();
    if (this.updateTimer) clearTimeout(this.updateTimer);
    for (const disposable of this.disposables) disposable.dispose();
    this.decorationType.dispose();
    this.statusBarItem.dispose();
  }

  /**
   * Runs the listener once, the first time inline blame is actually drawn.
   *
   * An overlap with another extension is only worth raising at the moment the
   * user can see it. At activation there may be no editor open, no repository,
   * or inline blame may be switched off, and the message would describe
   * something abstract instead of what is on screen.
   */
  public setFirstInlineRenderListener(listener: () => void): void {
    this.onFirstInlineRender = listener;
  }

  /** Re-blames the current line, e.g. after the repository state changed. */
  public refresh(): void {
    this.repositoryFiles.clear();
    this.userNames.clear();
    this.scheduleUpdate();
  }

  public async toggleInlineBlame(): Promise<void> {
    const configuration = getExtensionConfiguration();
    const enabled = configuration.get<boolean>(
      EXTENSION_SETTINGS.inlineBlameEnabled,
      EXTENSION_SETTING_DEFAULTS.inlineBlameEnabled,
    );
    await configuration.update(
      EXTENSION_SETTINGS.inlineBlameEnabled,
      !enabled,
      vscode.ConfigurationTarget.Global,
    );
    void vscode.window.showInformationMessage(
      enabled ? "Inline blame disabled." : "Inline blame enabled.",
    );
  }

  public async showLineBlameActions(): Promise<void> {
    const current = this.current;
    if (!current) {
      void vscode.window.showInformationMessage("No blame information for the current line.");
      return;
    }
    if (!current.blame.isCommitted) {
      void vscode.window.showInformationMessage("The current line is not committed yet.");
      return;
    }

    const commitNode = {
      commit: blameCommitInfo(current.blame),
      kind: "commit",
      repositoryRoot: current.repositoryRootPath,
    };
    const selected = await vscode.window.showQuickPick(
      [
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.showCommitDetails, commitNode),
          description: shortSha(current.blame.sha),
          label: "$(inspect) Show Commit Details",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(
              COMMAND_IDS.openFileAtRevision,
              current.repositoryRootPath,
              current.blame.sha,
              current.blame.path,
            ),
          description: shortSha(current.blame.sha),
          label: "$(go-to-file) Open File at This Revision",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.compareFileWithRevision),
          description: current.relativePath,
          label: "$(compare-changes) Compare File with Revision...",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.showFileHistory),
          description: current.relativePath,
          label: "$(history) Show File History",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.showLineHistory),
          description: current.relativePath,
          label: "$(list-selection) Show Line History",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.changeFileAnnotations),
          description: current.relativePath,
          label: "$(symbol-color) Change File Annotations...",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.copyCommitSha, commitNode),
          description: shortSha(current.blame.sha),
          label: "$(copy) Copy SHA",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.copyCommitMessage, commitNode),
          description: current.blame.summary,
          label: "$(copy) Copy Commit Message",
        },
      ],
      { placeHolder: current.blame.summary, title: "RefHaven: Line Blame" },
    );
    await selected?.action();
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      runInBackground(this.update(), this.logger, "Line blame update failed", "lineBlame");
    }, UPDATE_DEBOUNCE_MS);
  }

  private async update(): Promise<void> {
    this.activeUpdate?.abort();
    const abortController = new AbortController();
    this.activeUpdate = abortController;
    const generation = ++this.generation;
    const inlineEnabled = readExtensionSetting<boolean>(
      EXTENSION_SETTINGS.inlineBlameEnabled,
      EXTENSION_SETTING_DEFAULTS.inlineBlameEnabled,
    );
    const richHoverEnabled = readExtensionSetting<boolean>(
      EXTENSION_SETTINGS.lineHoverEnabled,
      EXTENSION_SETTING_DEFAULTS.lineHoverEnabled,
    );
    const statusBarEnabled = readExtensionSetting<boolean>(
      EXTENSION_SETTINGS.statusBarBlameEnabled,
      EXTENSION_SETTING_DEFAULTS.statusBarBlameEnabled,
    );

    const editor = vscode.window.activeTextEditor;
    if ((!inlineEnabled && !statusBarEnabled) || editor?.document.uri.scheme !== "file") {
      this.clearBlame();
      return;
    }

    const document = editor.document;
    const line = editor.selection.active.line;
    const target = await this.getRepositoryFile(document.uri.fsPath);
    if (generation !== this.generation) return;
    if (!target) {
      this.clearBlame();
      return;
    }
    const { filePath: relativePath, repositoryRoot: repositoryRootPath } = target;

    const blame = await blameLine(
      repositoryRootPath,
      relativePath,
      line + 1,
      document.isDirty ? document.getText() : undefined,
      abortController.signal,
    );
    if (generation !== this.generation) return;
    if (!blame) {
      this.clearBlame();
      return;
    }

    const userName = await this.getUserName(repositoryRootPath);
    if (generation !== this.generation) return;

    this.current = { blame, relativePath, repositoryRootPath };
    const now = Date.now();
    const hover = new vscode.MarkdownString(
      blameHoverMarkdown(blame, userName, repositoryRootPath, now),
    );
    hover.supportThemeIcons = true;
    hover.isTrusted = { enabledCommands: [...BLAME_HOVER_COMMANDS] };

    if (this.decoratedEditor && this.decoratedEditor !== editor) {
      this.decoratedEditor.setDecorations(this.decorationType, []);
    }
    if (inlineEnabled && line < document.lineCount) {
      const lineRange = document.lineAt(line).range;
      editor.setDecorations(this.decorationType, [
        {
          // The rich line hover supersedes this hover; keep the legacy one
          // so disabling refhaven.lineHover.enabled does not lose all hover.
          ...(richHoverEnabled ? {} : { hoverMessage: hover }),
          range: lineRange,
          renderOptions: {
            after: { contentText: inlineBlameText(blame, userName, now) },
          },
        },
      ]);
      this.decoratedEditor = editor;
      if (!this.inlineRenderReported) {
        this.inlineRenderReported = true;
        this.onFirstInlineRender?.();
      }
    } else {
      editor.setDecorations(this.decorationType, []);
      this.decoratedEditor = undefined;
    }

    if (statusBarEnabled) {
      this.statusBarItem.text = statusBarBlameText(blame, userName, now);
      this.statusBarItem.tooltip = hover;
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  private clearBlame(): void {
    this.current = undefined;
    if (this.decoratedEditor) {
      this.decoratedEditor.setDecorations(this.decorationType, []);
      this.decoratedEditor = undefined;
    }
    this.statusBarItem.hide();
  }

  private async getRepositoryFile(filePath: string): Promise<WorkspaceRepositoryFile | null> {
    const cached = this.repositoryFiles.get(filePath);
    if (cached) return cached;
    const target = await resolveWorkspaceRepositoryFile(filePath);
    if (target) this.repositoryFiles.set(filePath, target);
    return target;
  }

  private getUserName(repositoryRootPath: string): Promise<string | null> {
    let pending = this.userNames.get(repositoryRootPath);
    if (!pending) {
      pending = readGitUserName(repositoryRootPath);
      this.userNames.set(repositoryRootPath, pending);
    }
    return pending;
  }
}
