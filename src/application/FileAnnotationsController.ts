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
import type { BranchRef } from "../domain/comparison";
import { pathIdentityKey } from "../domain/pathValidation";
import {
  HEATMAP_BUCKET_DETAILS,
  HEATMAP_BUCKETS,
  heatmapBucket,
  heatmapFileModeOverride,
  normalizeFileBlameFormat,
  normalizeHeatmapLocations,
  normalizeHeatmapToggleMode,
  toggledHeatmapMode,
  type ChangedLineRange,
  type FileAnnotationMode,
  type FileBlameFormat,
  type HeatmapBucket,
  type HeatmapLocation,
  type HeatmapToggleMode,
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
import { blameAuthorLabel, fileBlameAnnotationText } from "../ui/blame/blamePresentation";
import { formatRelativeTime } from "../ui/format";
import { escapeMarkdown } from "../ui/markdown";
import { pickBranch } from "../ui/pickers/comparisonPickers";
import type { FileAnnotationChangesStore } from "./FileAnnotationChangesStore";

const MAX_ANNOTATED_LINES = 5_000;
const UPDATE_DEBOUNCE_MS = 300;
const FILE_ANNOTATIONS_ACTIVE_CONTEXT = "refhaven.fileAnnotations.active";

interface ActiveFileTarget {
  readonly editor: vscode.TextEditor;
  readonly filePath: string;
  readonly repositoryRoot: string;
}

interface ChangesBase {
  readonly baseRef: BranchRef;
  readonly repositoryRoot: string;
  readonly sha?: string;
}

interface AnnotationModeItem extends vscode.QuickPickItem {
  readonly annotationMode: FileAnnotationMode;
}

interface HeatmapSummary {
  readonly counts: Readonly<Record<HeatmapBucket, number>>;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly firstLines: Readonly<Record<HeatmapBucket, number | null>>;
  readonly total: number;
}

interface HeatmapLegendItem extends vscode.QuickPickItem {
  readonly bucket: HeatmapBucket;
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
    after: {
      color: new vscode.ThemeColor("refhaven.blame.annotationForeground"),
      fontStyle: "normal",
      margin: "0 0 0 3em",
    },
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
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
  private readonly fileModeOverrides = new Map<string, "heatmap" | "off">();
  private generation = 0;
  private annotationsActive = false;
  private mode: FileAnnotationMode;
  private readonly repositoryFiles = new Map<string, WorkspaceRepositoryFile>();
  private updateTimer: NodeJS.Timeout | undefined;
  private readonly userNames = new Map<string, Promise<string | null>>();

  public constructor(
    private readonly logger: Logger,
    private readonly changesStore: FileAnnotationChangesStore,
  ) {
    const savedChanges = this.changesStore.get();
    this.changesBase = savedChanges;
    this.mode = savedChanges ? "changes" : readConfiguredMode();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleUpdate()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) this.scheduleUpdate();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === vscode.window.activeTextEditor?.document) this.scheduleUpdate();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.fileModeOverrides.delete(document.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        const modeChanged = event.affectsConfiguration(
          extensionSettingPath(EXTENSION_SETTINGS.fileAnnotationsMode),
        );
        const locationsChanged = event.affectsConfiguration(
          extensionSettingPath(EXTENSION_SETTINGS.fileAnnotationsHeatmapLocations),
        );
        const blameChanged = [
          EXTENSION_SETTINGS.fileAnnotationsBlameFormat,
          EXTENSION_SETTINGS.fileAnnotationsBlameShowRepeated,
        ].some((setting) => event.affectsConfiguration(extensionSettingPath(setting)));
        if (!modeChanged && !locationsChanged && !blameChanged) return;
        if (modeChanged && this.mode !== "changes") {
          this.mode = readConfiguredMode();
          this.fileModeOverrides.clear();
        }
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
    this.setAnnotationsActive(false);
    for (const disposable of this.disposables) disposable.dispose();
    this.blameDecoration.dispose();
    this.changesDecoration.dispose();
    this.deletionDecoration.dispose();
    for (const decoration of Object.values(this.heatmapDecorations)) decoration.dispose();
  }

  public refresh(): void {
    this.repositoryFiles.clear();
    this.userNames.clear();
    if (this.changesBase) {
      this.changesBase = {
        baseRef: this.changesBase.baseRef,
        repositoryRoot: this.changesBase.repositoryRoot,
      };
    }
    this.scheduleUpdate();
  }

  public async changeAnnotations(): Promise<void> {
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    const currentMode = activeUri ? this.effectiveMode(activeUri) : this.mode;
    const items: AnnotationModeItem[] = [
      {
        annotationMode: "off",
        label: "$(circle-slash) Off",
        ...(currentMode === "off" ? { description: "current" } : {}),
      },
      {
        annotationMode: "blame",
        detail: "Readable author, age, and commit context for every line",
        label: "$(git-commit) Whole-file blame",
        ...(currentMode === "blame" ? { description: "current" } : {}),
      },
      {
        annotationMode: "heatmap",
        detail: "Working-tree changes plus five fixed commit-age bands",
        label: "$(color-mode) File heatmap",
        ...(currentMode === "heatmap" ? { description: "current" } : {}),
      },
      {
        annotationMode: "changes",
        detail: "Mark working-tree lines changed relative to a local reference",
        label: "$(diff) Changes relative to…",
        ...(currentMode === "changes" ? { description: "current" } : {}),
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
      const sha = await resolveRef(target.repositoryRoot, ref.fullName);
      const selection = {
        baseRef: ref,
        repositoryRoot: target.repositoryRoot,
        schemaVersion: 1 as const,
      };
      await this.changesStore.set(selection);
      this.changesBase = { ...selection, sha };
      this.fileModeOverrides.clear();
      this.mode = "changes";
    } else {
      await this.changesStore.set(undefined);
      await getExtensionConfiguration().update(
        EXTENSION_SETTINGS.fileAnnotationsMode,
        selected.annotationMode,
        vscode.ConfigurationTarget.Global,
      );
      this.fileModeOverrides.clear();
      this.mode = selected.annotationMode;
      this.changesBase = undefined;
    }

    this.logger.info("Changed whole-file annotation mode", {
      mode: this.mode,
      operation: "changeFileAnnotations",
      persisted: true,
    });
    await this.update(true);
  }

  public async toggleHeatmap(): Promise<void> {
    const target = await this.getActiveTarget();
    if (!target) {
      void vscode.window.showWarningMessage("Open a tracked file before toggling the heatmap.");
      return;
    }
    const toggleMode = readHeatmapToggleMode();
    let enabled: boolean;
    if (toggleMode === "file") {
      const uri = target.editor.document.uri.toString();
      enabled = this.effectiveMode(uri) !== "heatmap";
      const override = heatmapFileModeOverride(this.mode, enabled);
      if (override) this.fileModeOverrides.set(uri, override);
      else this.fileModeOverrides.delete(uri);
    } else {
      const nextMode = toggledHeatmapMode(this.mode, readConfiguredMode());
      await this.changesStore.set(undefined);
      await getExtensionConfiguration().update(
        EXTENSION_SETTINGS.fileAnnotationsMode,
        nextMode,
        vscode.ConfigurationTarget.Global,
      );
      this.fileModeOverrides.clear();
      this.mode = nextMode;
      enabled = nextMode === "heatmap";
      this.changesBase = undefined;
    }
    await this.update(true);
    void vscode.window.showInformationMessage(
      `RefHaven file heatmap ${enabled ? "enabled" : "off"} for this ${toggleMode}.`,
    );
  }

  public async dismiss(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") return;
    this.fileModeOverrides.set(editor.document.uri.toString(), "off");
    await this.update(false);
  }

  public async showHeatmapLegend(): Promise<void> {
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    const summary =
      this.heatmapSummary?.documentUri === activeUri ? this.heatmapSummary : undefined;
    const selected = await vscode.window.showQuickPick<HeatmapLegendItem>(
      HEATMAP_BUCKETS.map((bucket) => {
        const details = HEATMAP_BUCKET_DETAILS[bucket];
        const count = summary?.counts[bucket];
        const countDetail =
          count === undefined || !summary || summary.total === 0
            ? undefined
            : `${count.toLocaleString()} ${count === 1 ? "line" : "lines"} (${Math.round((count / summary.total) * 100).toString()}%)`;
        const firstLine = summary?.firstLines[bucket];
        return {
          bucket,
          description: details.age,
          ...(countDetail
            ? {
                detail: `${countDetail}${firstLine === null || firstLine === undefined ? "" : " - select to jump"}`,
              }
            : {}),
          label: `$(${HEATMAP_BUCKET_ICONS[bucket]}) ${details.label}`,
        };
      }),
      {
        placeHolder: "Colors follow the active theme and can be customized in VS Code settings",
        title: "RefHaven: File Heatmap Legend",
      },
    );
    const line = selected && summary ? summary.firstLines[selected.bucket] : null;
    const editor = vscode.window.activeTextEditor;
    if (!summary || line === null || !editor) return;
    if (
      editor.document.uri.toString() !== summary.documentUri ||
      editor.document.version !== summary.documentVersion
    ) {
      return;
    }
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  private scheduleUpdate(): void {
    this.activeUpdate?.abort();
    this.generation += 1;
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
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      this.clearDecorations();
      return;
    }
    const mode = this.effectiveMode(editor.document.uri.toString());
    if (mode === "off") {
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

    if (mode === "changes") {
      const base = this.changesBase;
      if (
        !base ||
        pathIdentityKey(base.repositoryRoot) !== pathIdentityKey(target.repositoryRoot)
      ) {
        this.clearDecorations();
        return;
      }
      try {
        const sha =
          base.sha ??
          (await resolveRef(target.repositoryRoot, base.baseRef.fullName, abortController.signal));
        if (generation !== this.generation) return;
        if (base.sha === undefined) this.changesBase = { ...base, sha };
        const ranges = await listChangedLineRanges(target.repositoryRoot, sha, target.filePath, {
          ...(target.editor.document.isDirty ? { contents: target.editor.document.getText() } : {}),
          signal: abortController.signal,
        });
        if (generation !== this.generation) return;
        this.renderChanges(target.editor, ranges, base.baseRef.displayName);
      } catch (error) {
        if (generation === this.generation) this.clearDecorations();
        throw error;
      }
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
    if (mode === "blame") this.renderBlame(target.editor, blame, userName);
    else this.renderHeatmap(target.editor, blame, userName);
  }

  private renderBlame(
    editor: vscode.TextEditor,
    lines: readonly FileBlameLine[],
    userName: string | null,
  ): void {
    this.prepareEditor(editor);
    const format = readFileBlameFormat();
    const showRepeated = readFileBlameShowRepeated();
    const now = Date.now();
    editor.setDecorations(
      this.blameDecoration,
      lines.flatMap((line, index) => {
        const range = lineRange(editor.document, line.lineNumber);
        if (!range) return [];
        const previous = lines[index - 1];
        const next = lines[index + 1];
        const sameAsPrevious = previous?.blame.sha === line.blame.sha;
        const sameAsNext = next?.blame.sha === line.blame.sha;
        const marker = blameBlockMarker(sameAsPrevious, sameAsNext);
        const details = fileBlameAnnotationText(line.blame, userName, now, format);
        return [
          {
            hoverMessage: blameHover(line, userName),
            range,
            renderOptions: {
              after: {
                contentText: showRepeated || !sameAsPrevious ? `${marker} ${details}` : marker,
              },
            },
          },
        ];
      }),
    );
    this.setAnnotationsActive(true);
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
    const firstLines = heatmapBucketRecord<number | null>(() => null);
    for (const line of lines) {
      const range = lineRange(editor.document, line.lineNumber);
      if (!range) continue;
      const bucket = heatmapBucket(line.blame.isCommitted ? line.blame.authorDate : null, now);
      counts[bucket] += 1;
      firstLines[bucket] ??= range.start.line;
      options[bucket].push({ hoverMessage: heatmapHover(line, userName, bucket), range });
    }
    for (const bucket of HEATMAP_BUCKETS) {
      editor.setDecorations(this.heatmapDecorations[bucket], options[bucket]);
    }
    this.heatmapSummary = {
      counts,
      documentUri: editor.document.uri.toString(),
      documentVersion: editor.document.version,
      firstLines,
      total: Object.values(counts).reduce((total, count) => total + count, 0),
    };
    this.setAnnotationsActive(true);
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
    this.setAnnotationsActive(true);
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
    this.setAnnotationsActive(false);
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

  private effectiveMode(documentUri: string): FileAnnotationMode {
    return this.fileModeOverrides.get(documentUri) ?? this.mode;
  }

  private setAnnotationsActive(active: boolean): void {
    if (this.annotationsActive === active) return;
    this.annotationsActive = active;
    runInBackground(
      Promise.resolve(
        vscode.commands.executeCommand("setContext", FILE_ANNOTATIONS_ACTIVE_CONTEXT, active),
      ),
      this.logger,
      "File annotations context update failed",
      "fileAnnotationsContext",
    );
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
          borderWidth: "0 3px 0 0",
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

function blameBlockMarker(sameAsPrevious: boolean, sameAsNext: boolean): string {
  if (!sameAsPrevious && !sameAsNext) return "\u2022";
  if (!sameAsPrevious) return "\u250c";
  if (!sameAsNext) return "\u2514";
  return "\u2502";
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

function readFileBlameFormat(): FileBlameFormat {
  return normalizeFileBlameFormat(
    readExtensionSetting<unknown>(
      EXTENSION_SETTINGS.fileAnnotationsBlameFormat,
      EXTENSION_SETTING_DEFAULTS.fileAnnotationsBlameFormat,
    ),
  );
}

function readFileBlameShowRepeated(): boolean {
  return (
    readExtensionSetting<unknown>(
      EXTENSION_SETTINGS.fileAnnotationsBlameShowRepeated,
      EXTENSION_SETTING_DEFAULTS.fileAnnotationsBlameShowRepeated,
    ) === true
  );
}

function readHeatmapToggleMode(): HeatmapToggleMode {
  return normalizeHeatmapToggleMode(
    readExtensionSetting<unknown>(
      EXTENSION_SETTINGS.fileAnnotationsHeatmapToggleMode,
      EXTENSION_SETTING_DEFAULTS.fileAnnotationsHeatmapToggleMode,
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
