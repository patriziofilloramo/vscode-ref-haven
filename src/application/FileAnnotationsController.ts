import { dirname, isAbsolute, relative, sep } from "node:path";

import * as vscode from "vscode";

import type { Logger } from "./Logger";
import type { FileBlameLine } from "../domain/blame";
import {
  heatmapBucket,
  type ChangedLineRange,
  type FileAnnotationMode,
  type HeatmapBucket,
} from "../domain/fileAnnotations";
import {
  blameFile,
  findRepositoryRoot,
  listChangedLineRanges,
  listComparisonRefs,
  readCurrentBranch,
  readGitUserName,
  resolveRef,
} from "../infrastructure/git/GitCli";
import { blameAuthorLabel } from "../ui/blame/blamePresentation";
import { formatRelativeTime } from "../ui/format";
import { escapeMarkdown } from "../ui/markdown";
import { pickBranch } from "../ui/pickers/comparisonPickers";

const CONFIG_SECTION = "refhaven";
const MODE_SETTING = "fileAnnotations.mode";
const MAX_ANNOTATED_LINES = 5_000;
const UPDATE_DEBOUNCE_MS = 300;
const GUTTER_ICON = vscode.Uri.parse(
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Ccircle cx='4' cy='4' r='2.5' fill='%23888888'/%3E%3C/svg%3E",
);

interface ActiveFileTarget {
  readonly editor: vscode.TextEditor;
  readonly filePath: string;
  readonly repositoryRoot: string;
}

interface ChangesBase {
  readonly label: string;
  readonly repositoryRoot: string;
  readonly sha: string;
}

interface AnnotationModeItem extends vscode.QuickPickItem {
  readonly annotationMode: FileAnnotationMode;
}

export class FileAnnotationsController implements vscode.Disposable {
  private activeUpdate: AbortController | undefined;
  private readonly blameDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: GUTTER_ICON,
    gutterIconSize: "contain",
  });
  private readonly changesDecoration = vscode.window.createTextEditorDecorationType({
    borderColor: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
    borderStyle: "solid",
    borderWidth: "0 0 0 2px",
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly deletionDecoration = vscode.window.createTextEditorDecorationType({
    borderColor: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
    borderStyle: "solid",
    borderWidth: "0 0 0 2px",
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly heatmapDecorations: Readonly<
    Record<HeatmapBucket, vscode.TextEditorDecorationType>
  > = {
    day: heatmapDecoration("rgba(56, 189, 113, 0.20)"),
    month: heatmapDecoration("rgba(234, 179, 8, 0.13)"),
    old: heatmapDecoration("rgba(128, 128, 128, 0.06)"),
    week: heatmapDecoration("rgba(56, 189, 113, 0.12)"),
    year: heatmapDecoration("rgba(249, 115, 22, 0.10)"),
  };
  private changesBase: ChangesBase | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private generation = 0;
  private mode: FileAnnotationMode;
  private readonly repositoryRoots = new Map<string, string>();
  private updateTimer: NodeJS.Timeout | undefined;
  private readonly userNames = new Map<string, Promise<string | null>>();

  public constructor(private readonly logger: Logger) {
    this.mode = readConfiguredMode();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleUpdate()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) this.scheduleUpdate();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === vscode.window.activeTextEditor?.document) this.scheduleUpdate();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(`${CONFIG_SECTION}.${MODE_SETTING}`)) return;
        if (this.mode !== "changes") this.mode = readConfiguredMode();
        this.scheduleUpdate();
      }),
    );
    this.scheduleUpdate();
  }

  public dispose(): void {
    this.activeUpdate?.abort();
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.clearDecorations();
    for (const disposable of this.disposables) disposable.dispose();
    this.blameDecoration.dispose();
    this.changesDecoration.dispose();
    this.deletionDecoration.dispose();
    for (const decoration of Object.values(this.heatmapDecorations)) decoration.dispose();
  }

  public refresh(): void {
    this.repositoryRoots.clear();
    this.userNames.clear();
    this.scheduleUpdate();
  }

  public async changeAnnotations(): Promise<void> {
    const items: AnnotationModeItem[] = [
      {
        annotationMode: "off",
        label: "$(circle-slash) Off",
        ...(this.mode === "off" ? { description: "current" } : {}),
      },
      {
        annotationMode: "blame",
        detail: "A blame marker and hover for every line",
        label: "$(git-commit) Whole-file blame",
        ...(this.mode === "blame" ? { description: "current" } : {}),
      },
      {
        annotationMode: "heatmap",
        detail: "Color lines by the age of their last commit",
        label: "$(color-mode) File heatmap",
        ...(this.mode === "heatmap" ? { description: "current" } : {}),
      },
      {
        annotationMode: "changes",
        detail: "Mark working-tree lines changed relative to a local reference",
        label: "$(diff) Changes relative to…",
        ...(this.mode === "changes" ? { description: "current" } : {}),
      },
    ];
    const selected = await vscode.window.showQuickPick<AnnotationModeItem>(items, {
      placeHolder: "Choose an annotation mode",
      title: "RefHaven: File Annotations",
    });
    if (!selected) return;

    if (selected.annotationMode === "changes") {
      const target = await this.getActiveTarget();
      if (!target) {
        void vscode.window.showWarningMessage(
          "Open a tracked file before enabling changes annotations.",
        );
        return;
      }
      const refs = await listComparisonRefs(target.repositoryRoot);
      const currentBranchName = await readCurrentBranch(target.repositoryRoot);
      const ref = await pickBranch(
        refs,
        "Select the reference used as the changes baseline",
        currentBranchName,
        target.repositoryRoot,
        false,
        "RefHaven: Changes Annotations",
      );
      if (!ref) return;
      this.changesBase = {
        label: ref.displayName,
        repositoryRoot: target.repositoryRoot,
        sha: await resolveRef(target.repositoryRoot, ref.fullName),
      };
      this.mode = "changes";
    } else {
      this.mode = selected.annotationMode;
      this.changesBase = undefined;
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(MODE_SETTING, this.mode, vscode.ConfigurationTarget.Global);
    }

    await this.update(true);
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.update(false).catch((error: unknown) => {
        this.logger.error("File annotations update failed", {
          message: error instanceof Error ? error.message : String(error),
          operation: "fileAnnotations",
        });
      });
    }, UPDATE_DEBOUNCE_MS);
  }

  private async update(interactive: boolean): Promise<void> {
    this.activeUpdate?.abort();
    const abortController = new AbortController();
    this.activeUpdate = abortController;
    const generation = ++this.generation;
    if (this.mode === "off") {
      this.clearDecorations();
      return;
    }

    const target = await this.getActiveTarget();
    if (generation !== this.generation) return;
    if (!target) {
      this.clearDecorations();
      return;
    }
    if (target.editor.document.lineCount > MAX_ANNOTATED_LINES) {
      this.clearDecorations();
      if (interactive) {
        void vscode.window.showWarningMessage(
          `File annotations are limited to ${MAX_ANNOTATED_LINES.toLocaleString()} lines to keep the editor responsive.`,
        );
      }
      return;
    }

    if (this.mode === "changes") {
      const base = this.changesBase;
      if (base?.repositoryRoot !== target.repositoryRoot) {
        this.clearDecorations();
        return;
      }
      if (target.editor.document.isDirty) {
        this.clearDecorations();
        if (interactive) {
          void vscode.window.showInformationMessage(
            "Save the file to calculate changes annotations against the selected reference.",
          );
        }
        return;
      }
      const ranges = await listChangedLineRanges(
        target.repositoryRoot,
        base.sha,
        target.filePath,
        abortController.signal,
      );
      if (generation !== this.generation) return;
      this.renderChanges(target.editor, ranges, base.label);
      return;
    }

    const blame = await blameFile(
      target.repositoryRoot,
      target.filePath,
      target.editor.document.isDirty ? target.editor.document.getText() : undefined,
      abortController.signal,
    );
    const userName = await this.getUserName(target.repositoryRoot);
    if (generation !== this.generation) return;
    if (this.mode === "blame") this.renderBlame(target.editor, blame, userName);
    else this.renderHeatmap(target.editor, blame, userName);
  }

  private renderBlame(
    editor: vscode.TextEditor,
    lines: readonly FileBlameLine[],
    userName: string | null,
  ): void {
    this.prepareEditor(editor);
    editor.setDecorations(
      this.blameDecoration,
      lines.flatMap((line) => {
        const range = lineRange(editor.document, line.lineNumber);
        return range ? [{ hoverMessage: blameHover(line, userName), range }] : [];
      }),
    );
  }

  private renderHeatmap(
    editor: vscode.TextEditor,
    lines: readonly FileBlameLine[],
    userName: string | null,
  ): void {
    this.prepareEditor(editor);
    const now = Date.now();
    const options: Record<HeatmapBucket, vscode.DecorationOptions[]> = {
      day: [],
      month: [],
      old: [],
      week: [],
      year: [],
    };
    for (const line of lines) {
      const range = lineRange(editor.document, line.lineNumber);
      if (!range) continue;
      const bucket = line.blame.isCommitted ? heatmapBucket(line.blame.authorDate, now) : "day";
      options[bucket].push({ hoverMessage: blameHover(line, userName), range });
    }
    for (const [bucket, decoration] of Object.entries(this.heatmapDecorations) as [
      HeatmapBucket,
      vscode.TextEditorDecorationType,
    ][]) {
      editor.setDecorations(decoration, options[bucket]);
    }
  }

  private renderChanges(
    editor: vscode.TextEditor,
    ranges: readonly ChangedLineRange[],
    baseLabel: string,
  ): void {
    this.prepareEditor(editor);
    const changed: vscode.DecorationOptions[] = [];
    const deleted: vscode.DecorationOptions[] = [];
    for (const range of ranges) {
      const start = Math.min(Math.max(range.startLine - 1, 0), editor.document.lineCount - 1);
      const hoverMessage = new vscode.MarkdownString(
        range.lineCount === 0
          ? `Deleted lines relative to **${escapeMarkdown(baseLabel)}**`
          : `Changed relative to **${escapeMarkdown(baseLabel)}**`,
      );
      if (range.lineCount === 0) {
        deleted.push({ hoverMessage, range: editor.document.lineAt(start).range });
      } else {
        const end = Math.min(start + range.lineCount - 1, editor.document.lineCount - 1);
        changed.push({
          hoverMessage,
          range: new vscode.Range(start, 0, end, editor.document.lineAt(end).range.end.character),
        });
      }
    }
    editor.setDecorations(this.changesDecoration, changed);
    editor.setDecorations(this.deletionDecoration, deleted);
  }

  private prepareEditor(editor: vscode.TextEditor): void {
    if (this.decoratedEditor && this.decoratedEditor !== editor) {
      this.clearEditor(this.decoratedEditor);
    }
    this.clearEditor(editor);
    this.decoratedEditor = editor;
  }

  private clearDecorations(): void {
    if (this.decoratedEditor) this.clearEditor(this.decoratedEditor);
    this.decoratedEditor = undefined;
  }

  private clearEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this.blameDecoration, []);
    editor.setDecorations(this.changesDecoration, []);
    editor.setDecorations(this.deletionDecoration, []);
    for (const decoration of Object.values(this.heatmapDecorations)) {
      editor.setDecorations(decoration, []);
    }
  }

  private async getActiveTarget(): Promise<ActiveFileTarget | null> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") return null;
    const directory = dirname(editor.document.uri.fsPath);
    let repositoryRoot = this.repositoryRoots.get(directory);
    if (!repositoryRoot) {
      repositoryRoot = (await findRepositoryRoot(directory)) ?? undefined;
      if (!repositoryRoot) return null;
      this.repositoryRoots.set(directory, repositoryRoot);
    }
    const nativePath = relative(repositoryRoot, editor.document.uri.fsPath);
    if (nativePath === ".." || nativePath.startsWith(`..${sep}`) || isAbsolute(nativePath)) {
      return null;
    }
    return { editor, filePath: nativePath.replaceAll("\\", "/"), repositoryRoot };
  }

  private getUserName(repositoryRoot: string): Promise<string | null> {
    let pending = this.userNames.get(repositoryRoot);
    if (!pending) {
      pending = readGitUserName(repositoryRoot);
      this.userNames.set(repositoryRoot, pending);
    }
    return pending;
  }
}

function heatmapDecoration(backgroundColor: string): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    backgroundColor,
    isWholeLine: true,
    overviewRulerColor: backgroundColor,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
}

function lineRange(document: vscode.TextDocument, oneBasedLine: number): vscode.Range | null {
  const line = oneBasedLine - 1;
  return line >= 0 && line < document.lineCount ? document.lineAt(line).range : null;
}

function blameHover(line: FileBlameLine, userName: string | null): vscode.MarkdownString {
  const { blame } = line;
  const author = escapeMarkdown(blameAuthorLabel(blame, userName));
  if (!blame.isCommitted) return new vscode.MarkdownString(`**${author}** · Uncommitted changes`);
  return new vscode.MarkdownString(
    [
      `**${author}**, ${formatRelativeTime(blame.authorDate)}`,
      escapeMarkdown(blame.summary),
      `\`${blame.sha.slice(0, 8)}\``,
    ].join("\n\n"),
  );
}

function readConfiguredMode(): Exclude<FileAnnotationMode, "changes"> {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(MODE_SETTING, "off");
  return value === "blame" || value === "heatmap" ? value : "off";
}
