import { dirname, isAbsolute, relative, sep } from "node:path";

import * as vscode from "vscode";

import type { Logger } from "./Logger";
import type { LineBlame } from "../domain/blame";
import { shortSha } from "../domain/comparisonResult";
import { blameLine, findRepositoryRoot, readGitUserName } from "../infrastructure/git/GitCli";
import {
  BLAME_HOVER_COMMANDS,
  blameCommitInfo,
  blameHoverMarkdown,
  inlineBlameText,
  statusBarBlameText,
} from "../ui/blame/blamePresentation";
import { COMMAND_IDS } from "../ui/commands/commandIds";

const CONFIG_SECTION = "branchCompare";
const INLINE_BLAME_SETTING = "inlineBlame.enabled";
const STATUS_BAR_BLAME_SETTING = "statusBarBlame.enabled";
const UPDATE_DEBOUNCE_MS = 250;

interface CurrentLineBlame {
  readonly blame: LineBlame;
  readonly relativePath: string;
  readonly repositoryRootPath: string;
}

/** Shows blame for the cursor's line as inline text and a status bar entry. */
export class BlameController implements vscode.Disposable {
  private current: CurrentLineBlame | undefined;
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
  private readonly repositoryRoots = new Map<string, string>();
  private readonly statusBarItem: vscode.StatusBarItem;
  private updateTimer: NodeJS.Timeout | undefined;
  private readonly userNames = new Map<string, Promise<string | null>>();

  public constructor(private readonly logger: Logger) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      "branchCompare.lineBlame",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.name = "Branch Compare Line Blame";
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
        if (event.affectsConfiguration(CONFIG_SECTION)) this.scheduleUpdate();
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

  /** Re-blames the current line, e.g. after the repository state changed. */
  public refresh(): void {
    this.repositoryRoots.clear();
    this.userNames.clear();
    this.scheduleUpdate();
  }

  public async toggleInlineBlame(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const enabled = configuration.get<boolean>(INLINE_BLAME_SETTING, true);
    await configuration.update(INLINE_BLAME_SETTING, !enabled, vscode.ConfigurationTarget.Global);
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

    const commitNode = { commit: blameCommitInfo(current.blame), kind: "commit" };
    const selected = await vscode.window.showQuickPick(
      [
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
      ],
      { placeHolder: current.blame.summary, title: "Branch Compare: Line Blame" },
    );
    await selected?.action();
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.update().catch((error: unknown) => {
        this.logger.error("Line blame update failed", {
          message: error instanceof Error ? error.message : String(error),
          operation: "lineBlame",
        });
      });
    }, UPDATE_DEBOUNCE_MS);
  }

  private async update(): Promise<void> {
    this.activeUpdate?.abort();
    const abortController = new AbortController();
    this.activeUpdate = abortController;
    const generation = ++this.generation;
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const inlineEnabled = configuration.get<boolean>(INLINE_BLAME_SETTING, true);
    const statusBarEnabled = configuration.get<boolean>(STATUS_BAR_BLAME_SETTING, true);

    const editor = vscode.window.activeTextEditor;
    if ((!inlineEnabled && !statusBarEnabled) || editor?.document.uri.scheme !== "file") {
      this.clearBlame();
      return;
    }

    const document = editor.document;
    const line = editor.selection.active.line;
    const repositoryRootPath = await this.getRepositoryRoot(dirname(document.uri.fsPath));
    if (generation !== this.generation) return;
    if (!repositoryRootPath) {
      this.clearBlame();
      return;
    }

    const nativeRelativePath = relative(repositoryRootPath, document.uri.fsPath);
    if (
      nativeRelativePath === ".." ||
      nativeRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(nativeRelativePath)
    ) {
      this.clearBlame();
      return;
    }
    const relativePath = nativeRelativePath.replaceAll("\\", "/");

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
      const lineEnd = document.lineAt(line).range.end;
      editor.setDecorations(this.decorationType, [
        {
          hoverMessage: hover,
          range: new vscode.Range(lineEnd, lineEnd),
          renderOptions: {
            after: { contentText: inlineBlameText(blame, userName, now) },
          },
        },
      ]);
      this.decoratedEditor = editor;
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

  private async getRepositoryRoot(directory: string): Promise<string | null> {
    const cached = this.repositoryRoots.get(directory);
    if (cached) return cached;
    const repositoryRoot = await findRepositoryRoot(directory);
    if (repositoryRoot) this.repositoryRoots.set(directory, repositoryRoot);
    return repositoryRoot;
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
