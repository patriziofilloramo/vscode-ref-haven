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
import type { LineBlame, LineBlameActionTarget } from "../domain/blame";
import { shortSha, type CommitInfo } from "../domain/comparisonResult";
import { isLineBlameActionTarget } from "../domain/validation";
import {
  blameLine,
  readCommitDetails,
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
import { showTransientSuccess } from "../ui/feedback";
import { resolveKnownFileTarget } from "../ui/commands/fileContext";

const UPDATE_DEBOUNCE_MS = 250;

interface CurrentLineBlame {
  readonly blame: LineBlame;
  readonly lineNumber: number;
  readonly relativePath: string;
  readonly repositoryRootPath: string;
}

interface ResolvedLineBlameActionTarget extends LineBlameActionTarget {
  readonly commit: CommitInfo;
  readonly uri: vscode.Uri;
}

interface LineBlameActionItem extends vscode.QuickPickItem {
  readonly action: () => Thenable<unknown>;
}

interface LineBlameActionSeparator extends vscode.QuickPickItem {
  readonly kind: vscode.QuickPickItemKind.Separator;
}

type LineBlameActionEntry = LineBlameActionItem | LineBlameActionSeparator;

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
    showTransientSuccess(enabled ? "Inline blame disabled" : "Inline blame enabled");
  }

  public async showLineBlameActions(candidate?: unknown): Promise<void> {
    const target = await this.resolveLineBlameActionTarget(candidate);
    if (!target) return;
    const commitNode = {
      commit: target.commit,
      kind: "commit",
      repositoryRoot: target.repositoryRoot,
    };
    const selected = await vscode.window.showQuickPick<LineBlameActionEntry>(
      [
        lineBlameActionSeparator("Inspect"),
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.showCommitDetails, commitNode),
          description: shortSha(target.sha),
          label: "$(inspect) Show Commit Details",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(
              COMMAND_IDS.openFileAtRevision,
              target.repositoryRoot,
              target.sha,
              target.revisionPath,
            ),
          description: shortSha(target.sha),
          label: "$(go-to-file) Open File at This Revision",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(
              COMMAND_IDS.compareFileWithRevision,
              target.repositoryRoot,
              target.sha,
              target.filePath,
              shortSha(target.sha),
            ),
          description: target.filePath,
          label: "$(compare-changes) Compare File with Revision...",
        },
        lineBlameActionSeparator("History and annotations"),
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(
              COMMAND_IDS.showFileHistory,
              target.repositoryRoot,
              target.filePath,
            ),
          description: target.filePath,
          label: "$(history) Show File History",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(
              COMMAND_IDS.showLineHistory,
              target.repositoryRoot,
              target.filePath,
              target.lineNumber,
            ),
          description: `${target.filePath}:${target.lineNumber.toString()}`,
          label: "$(list-selection) Show Line History",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.changeFileAnnotations, target.uri),
          description: target.filePath,
          label: "$(symbol-color) Change File Annotations...",
        },
        lineBlameActionSeparator("Copy"),
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.copyCommitSha, commitNode),
          description: shortSha(target.sha),
          label: "$(copy) Copy SHA",
        },
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(COMMAND_IDS.copyCommitMessage, commitNode),
          description: target.commit.subject,
          label: "$(copy) Copy Commit Message",
        },
        lineBlameActionSeparator("Remote"),
        {
          action: (): Thenable<unknown> =>
            vscode.commands.executeCommand(
              COMMAND_IDS.openBrowserFile,
              target.repositoryRoot,
              target.sha,
              target.revisionPath,
              target.revisionLineNumber,
            ),
          description: target.revisionPath,
          label: "$(link-external) Open File in Browser",
        },
      ],
      {
        placeHolder: target.commit.subject || shortSha(target.sha),
        title: "RefHaven: Line Blame",
      },
    );
    if (selected && "action" in selected) await selected.action();
  }

  private async resolveLineBlameActionTarget(
    candidate: unknown,
  ): Promise<ResolvedLineBlameActionTarget | null> {
    if (candidate === undefined) {
      const current = this.current;
      if (!current) {
        void vscode.window.showInformationMessage("No blame information for the current line.");
        return null;
      }
      if (!current.blame.isCommitted) {
        void vscode.window.showInformationMessage("The current line is not committed yet.");
        return null;
      }
      const fileTarget = await resolveKnownFileTarget(
        current.repositoryRootPath,
        current.relativePath,
      );
      if (!fileTarget) throw new Error("The blamed file is no longer available in this workspace.");
      return {
        commit: blameCommitInfo(current.blame),
        filePath: fileTarget.filePath,
        lineNumber: current.lineNumber,
        repositoryRoot: fileTarget.repositoryRoot,
        revisionLineNumber: current.blame.originalLineNumber ?? current.lineNumber,
        revisionPath: current.blame.path,
        sha: current.blame.sha,
        uri: fileTarget.uri,
      };
    }

    if (!isLineBlameActionTarget(candidate)) {
      throw new Error("The line blame action target is invalid.");
    }
    const fileTarget = await resolveKnownFileTarget(candidate.repositoryRoot, candidate.filePath);
    if (!fileTarget) throw new Error("The blamed file is no longer available in this workspace.");
    const details = await readCommitDetails(fileTarget.repositoryRoot, candidate.sha);
    return {
      ...candidate,
      commit: details.commit,
      filePath: fileTarget.filePath,
      repositoryRoot: fileTarget.repositoryRoot,
      uri: fileTarget.uri,
    };
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

    this.current = { blame, lineNumber: line + 1, relativePath, repositoryRootPath };
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

function lineBlameActionSeparator(label: string): LineBlameActionSeparator {
  return { kind: vscode.QuickPickItemKind.Separator, label };
}
