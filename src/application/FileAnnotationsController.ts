import * as vscode from "vscode";

import {
  EXTENSION_SETTING_DEFAULTS,
  EXTENSION_SETTINGS,
  extensionSettingPath,
  getExtensionConfiguration,
  readExtensionSetting,
} from "../config/extensionConfiguration";
import { HEATMAP_COLOR_IDS } from "../config/heatmapColors";
import { runInBackground } from "./errorHandling";
import type { Logger } from "./Logger";
import type { FileBlameLine } from "../domain/blame";
import {
  HEATMAP_BUCKET_DETAILS,
  HEATMAP_BUCKETS,
  heatmapBucket,
  normalizeHeatmapLocations,
  toggledHeatmapMode,
  type ChangedLineRange,
  type FileAnnotationMode,
  type HeatmapBucket,
  type HeatmapLocation,
} from "../domain/fileAnnotations";
import {
  blameFile,
  listChangedLineRanges,
  listComparisonRefs,
  readCurrentBranch,
  readGitUserName,
  resolveWorkspaceRepositoryFile,
  resolveRef,
  type WorkspaceRepositoryFile,
} from "../infrastructure/git/GitCli";
import { blameAuthorLabel } from "../ui/blame/blamePresentation";
import { formatRelativeTime } from "../ui/format";
import { escapeMarkdown } from "../ui/markdown";
import { pickBranch } from "../ui/pickers/comparisonPickers";

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

interface HeatmapSummary {
  readonly counts: Readonly<Record<HeatmapBucket, number>>;
  readonly documentUri: string;
  readonly total: number;
}

const HEATMAP_BUCKET_ICONS: Readonly<Record<HeatmapBucket, string>> = {
  day: "flame",
  month: "circle-large-filled",
  old: "archive",
  uncommitted: "edit",
  week: "circle-filled",
  year: "history",
};

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
  private heatmapDecorations = createHeatmapDecorations();
  private heatmapSummary: HeatmapSummary | undefined;
  private changesBase: ChangesBase | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private generation = 0;
  private mode: FileAnnotationMode;
  private readonly repositoryFiles = new Map<string, WorkspaceRepositoryFile>();
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
        const modeChanged = event.affectsConfiguration(
          extensionSettingPath(EXTENSION_SETTINGS.fileAnnotationsMode),
        );
        const locationsChanged = event.affectsConfiguration(
          extensionSettingPath(EXTENSION_SETTINGS.fileAnnotationsHeatmapLocations),
        );
        if (!modeChanged && !locationsChanged) return;
        if (modeChanged && this.mode !== "changes") this.mode = readConfiguredMode();
        if (locationsChanged) this.replaceHeatmapDecorations();
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
    this.repositoryFiles.clear();
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
        detail: "Working-tree changes plus five fixed commit-age bands",
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
      await getExtensionConfiguration().update(
        EXTENSION_SETTINGS.fileAnnotationsMode,
        this.mode,
        vscode.ConfigurationTarget.Global,
      );
    }

    await this.update(true);
  }

  public async toggleHeatmap(): Promise<void> {
    this.mode = toggledHeatmapMode(this.mode, readConfiguredMode());
    const enabled = this.mode === "heatmap";
    this.changesBase = undefined;
    await getExtensionConfiguration().update(
      EXTENSION_SETTINGS.fileAnnotationsMode,
      this.mode,
      vscode.ConfigurationTarget.Global,
    );
    await this.update(true);
    void vscode.window.showInformationMessage(
      `RefHaven file heatmap ${enabled ? "enabled" : "off"}.`,
    );
  }

  public async showHeatmapLegend(): Promise<void> {
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    const summary =
      this.heatmapSummary?.documentUri === activeUri ? this.heatmapSummary : undefined;
    await vscode.window.showQuickPick(
      HEATMAP_BUCKETS.map((bucket) => {
        const details = HEATMAP_BUCKET_DETAILS[bucket];
        const count = summary?.counts[bucket];
        const countDetail =
          count === undefined || !summary || summary.total === 0
            ? undefined
            : `${count.toLocaleString()} ${count === 1 ? "line" : "lines"} (${Math.round((count / summary.total) * 100).toString()}%)`;
        return {
          description: details.age,
          ...(countDetail ? { detail: countDetail } : {}),
          label: `$(${HEATMAP_BUCKET_ICONS[bucket]}) ${details.label}`,
        };
      }),
      {
        placeHolder: "Colors follow the active theme and can be customized in VS Code settings",
        title: "RefHaven: File Heatmap Legend",
      },
    );
  }

  private scheduleUpdate(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      runInBackground(
        this.update(false),
        this.logger,
        "File annotations update failed",
        "fileAnnotations",
      );
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
    const options = heatmapBucketRecord<vscode.DecorationOptions[]>(() => []);
    const counts = heatmapBucketRecord(() => 0);
    for (const line of lines) {
      const range = lineRange(editor.document, line.lineNumber);
      if (!range) continue;
      const bucket = heatmapBucket(line.blame.isCommitted ? line.blame.authorDate : null, now);
      counts[bucket] += 1;
      options[bucket].push({ hoverMessage: heatmapHover(line, userName, bucket), range });
    }
    for (const bucket of HEATMAP_BUCKETS) {
      editor.setDecorations(this.heatmapDecorations[bucket], options[bucket]);
    }
    this.heatmapSummary = {
      counts,
      documentUri: editor.document.uri.toString(),
      total: Object.values(counts).reduce((total, count) => total + count, 0),
    };
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
    this.heatmapSummary = undefined;
    if (this.decoratedEditor && this.decoratedEditor !== editor) {
      this.clearEditor(this.decoratedEditor);
    }
    this.clearEditor(editor);
    this.decoratedEditor = editor;
  }

  private clearDecorations(): void {
    if (this.decoratedEditor) this.clearEditor(this.decoratedEditor);
    this.decoratedEditor = undefined;
    this.heatmapSummary = undefined;
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
    const filePath = editor.document.uri.fsPath;
    let target = this.repositoryFiles.get(filePath);
    if (!target) {
      target = (await resolveWorkspaceRepositoryFile(filePath)) ?? undefined;
      if (!target) return null;
      this.repositoryFiles.set(filePath, target);
    }
    return { editor, ...target };
  }

  private getUserName(repositoryRoot: string): Promise<string | null> {
    let pending = this.userNames.get(repositoryRoot);
    if (!pending) {
      pending = readGitUserName(repositoryRoot);
      this.userNames.set(repositoryRoot, pending);
    }
    return pending;
  }

  private replaceHeatmapDecorations(): void {
    if (this.decoratedEditor) {
      for (const decoration of Object.values(this.heatmapDecorations)) {
        this.decoratedEditor.setDecorations(decoration, []);
      }
    }
    for (const decoration of Object.values(this.heatmapDecorations)) decoration.dispose();
    this.heatmapDecorations = createHeatmapDecorations();
    this.heatmapSummary = undefined;
  }
}

function createHeatmapDecorations(): Record<HeatmapBucket, vscode.TextEditorDecorationType> {
  const locations = readHeatmapLocations();
  return heatmapBucketRecord((bucket) => heatmapDecoration(bucket, locations));
}

function heatmapDecoration(
  bucket: HeatmapBucket,
  locations: readonly HeatmapLocation[],
): vscode.TextEditorDecorationType {
  const colors = HEATMAP_COLOR_IDS[bucket];
  const edge = locations.includes("edge");
  const overview = locations.includes("overview");
  return vscode.window.createTextEditorDecorationType({
    ...(locations.includes("line")
      ? { backgroundColor: new vscode.ThemeColor(colors.background) }
      : {}),
    ...(edge
      ? {
          borderColor: new vscode.ThemeColor(colors.foreground),
          borderStyle: "solid",
          borderWidth: "0 0 0 3px",
        }
      : {}),
    isWholeLine: true,
    ...(overview
      ? {
          overviewRulerColor: new vscode.ThemeColor(colors.foreground),
          overviewRulerLane: vscode.OverviewRulerLane.Left,
        }
      : {}),
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

function heatmapHover(
  line: FileBlameLine,
  userName: string | null,
  bucket: HeatmapBucket,
): vscode.MarkdownString {
  const details = HEATMAP_BUCKET_DETAILS[bucket];
  const { blame } = line;
  const author = escapeMarkdown(blameAuthorLabel(blame, userName));
  if (!blame.isCommitted) {
    return new vscode.MarkdownString(
      [`**Heatmap - ${details.label}**`, `**${author}** - Uncommitted changes`].join("\n\n"),
    );
  }
  return new vscode.MarkdownString(
    [
      `**Heatmap - ${details.label}** - ${details.age}`,
      `**${author}**, ${formatRelativeTime(blame.authorDate)}`,
      escapeMarkdown(blame.summary),
      `\`${blame.sha.slice(0, 8)}\``,
    ].join("\n\n"),
  );
}

function heatmapBucketRecord<T>(
  createValue: (bucket: HeatmapBucket) => T,
): Record<HeatmapBucket, T> {
  return Object.fromEntries(
    HEATMAP_BUCKETS.map((bucket) => [bucket, createValue(bucket)]),
  ) as Record<HeatmapBucket, T>;
}

function readHeatmapLocations(): readonly HeatmapLocation[] {
  return normalizeHeatmapLocations(
    readExtensionSetting<unknown>(
      EXTENSION_SETTINGS.fileAnnotationsHeatmapLocations,
      EXTENSION_SETTING_DEFAULTS.fileAnnotationsHeatmapLocations,
    ),
  );
}

function readConfiguredMode(): Exclude<FileAnnotationMode, "changes"> {
  const value = readExtensionSetting<unknown>(
    EXTENSION_SETTINGS.fileAnnotationsMode,
    EXTENSION_SETTING_DEFAULTS.fileAnnotationsMode,
  );
  return value === "blame" || value === "heatmap" ? value : "off";
}
