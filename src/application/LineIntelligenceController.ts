import * as vscode from "vscode";

import {
  EXTENSION_SETTING_DEFAULTS,
  EXTENSION_SETTINGS,
  getExtensionConfiguration,
  readExtensionSetting,
} from "../config/extensionConfiguration";
import {
  hasOtherBlameExtension,
  lineIntelligenceMode,
  lineIntelligenceSettings,
  type InstalledExtensionManifest,
  type LineIntelligenceMode,
} from "../domain/lineIntelligence";
import { openExternalUrl } from "../ui/externalLink";
import { showTransientSuccess } from "../ui/feedback";
import type { Logger } from "./Logger";

const OVERLAP_NOTICE_KEY = "refhaven.lineIntelligenceOverlapNoticeShown";
const COEXISTENCE_GUIDE_URL = "https://patriziofilloramo.github.io/ref-haven/#coexistence";

const MODE_LABELS: Readonly<Record<LineIntelligenceMode, string>> = {
  full: "Full",
  hoverOnly: "Hover only",
  off: "Off",
};

const MODE_DETAILS: Readonly<Record<LineIntelligenceMode, string>> = {
  full: "Inline blame on the current line, the rich line hover, and the status bar entry.",
  hoverOnly: "Only the rich line hover. Use this alongside another blame extension.",
  off: "No per-line surfaces. Comparisons, history, stashes, and patches are unaffected.",
};

/**
 * Owns the three per-line surfaces as one user-facing choice, and tells the
 * user once when another installed extension contributes the same thing.
 */
export class LineIntelligenceController {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {}

  /** Applies one coherent mode across the three settings in a single gesture. */
  public async chooseMode(): Promise<void> {
    const current = this.currentMode();
    const selected = await vscode.window.showQuickPick(
      (["full", "hoverOnly", "off"] as const).map((mode) => ({
        detail: MODE_DETAILS[mode],
        label: MODE_LABELS[mode],
        mode,
        ...(mode === current ? { description: "current" } : {}),
      })),
      {
        placeHolder: "Choose which per-line surfaces RefHaven shows",
        title: "RefHaven: Line Intelligence",
      },
    );
    if (!selected) return;
    await this.applyMode(selected.mode);
    showTransientSuccess(`Line intelligence: ${MODE_LABELS[selected.mode]}`);
  }

  /**
   * Shows a single dismissible notice when another blame extension is present.
   *
   * Nothing is changed without the user asking. Whichever button is pressed —
   * including dismissal — the notice never appears again, so this costs at
   * most one interruption in the extension's lifetime and only for users who
   * would otherwise see doubled text with no explanation.
   */
  public async noticeOverlapOnce(): Promise<void> {
    if (this.context.globalState.get<boolean>(OVERLAP_NOTICE_KEY) === true) return;
    if (this.currentMode() !== "full") return;
    if (!hasOtherBlameExtension(installedExtensionManifests(), this.context.extension.id)) return;

    await this.context.globalState.update(OVERLAP_NOTICE_KEY, true);
    this.logger.info("Reported line intelligence overlap", { operation: "lineIntelligence" });

    const useHoverOnly = "Use Hover Only";
    const keepEverything = "Keep Everything";
    const learnMore = "Learn More";
    // Names the symptom, then what the recommended choice actually buys:
    // "the line reads twice" alone tells the user something is wrong without
    // telling them what they gain or give up by fixing it.
    const action = await vscode.window.showInformationMessage(
      "Another installed extension also shows blame on the current line, so it appears twice. RefHaven can show only its hover instead: the duplicate goes away and you keep the diff that produced the line.",
      useHoverOnly,
      keepEverything,
      learnMore,
    );
    if (action === useHoverOnly) {
      await this.applyMode("hoverOnly");
      showTransientSuccess("Line intelligence: Hover only");
    } else if (action === learnMore) {
      await openExternalUrl(COEXISTENCE_GUIDE_URL);
    }
  }

  private currentMode(): LineIntelligenceMode {
    return lineIntelligenceMode({
      inlineBlame: this.readFlag(
        EXTENSION_SETTINGS.inlineBlameEnabled,
        EXTENSION_SETTING_DEFAULTS.inlineBlameEnabled,
      ),
      lineHover: this.readFlag(
        EXTENSION_SETTINGS.lineHoverEnabled,
        EXTENSION_SETTING_DEFAULTS.lineHoverEnabled,
      ),
      statusBar: this.readFlag(
        EXTENSION_SETTINGS.statusBarBlameEnabled,
        EXTENSION_SETTING_DEFAULTS.statusBarBlameEnabled,
      ),
    });
  }

  private readFlag(
    setting: (typeof EXTENSION_SETTINGS)[keyof typeof EXTENSION_SETTINGS],
    fallback: boolean,
  ): boolean {
    return readExtensionSetting<boolean>(setting, fallback);
  }

  private async applyMode(mode: LineIntelligenceMode): Promise<void> {
    const settings = lineIntelligenceSettings(mode);
    const configuration = getExtensionConfiguration();
    const target =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await Promise.all([
      configuration.update(EXTENSION_SETTINGS.inlineBlameEnabled, settings.inlineBlame, target),
      configuration.update(EXTENSION_SETTINGS.lineHoverEnabled, settings.lineHover, target),
      configuration.update(EXTENSION_SETTINGS.statusBarBlameEnabled, settings.statusBar, target),
    ]);
    this.logger.info("Applied line intelligence mode", { mode, operation: "lineIntelligence" });
  }
}

/**
 * Reads the contributed surfaces of installed extensions. Manifests are
 * already in memory: this inspects local metadata only and starts no
 * activation, no process, and no network request.
 */
function installedExtensionManifests(): InstalledExtensionManifest[] {
  return vscode.extensions.all.map((extension) => {
    const contributes = (
      extension.packageJSON as {
        readonly contributes?: {
          readonly commands?: readonly { readonly command?: unknown; readonly title?: unknown }[];
          readonly configuration?: unknown;
        };
      }
    ).contributes;
    const commands = Array.isArray(contributes?.commands) ? contributes.commands : [];
    return {
      commandIds: commands.map(({ command }) => (typeof command === "string" ? command : "")),
      commandTitles: commands.map(({ title }) => (typeof title === "string" ? title : "")),
      id: extension.id,
      settingKeys: configurationKeys(contributes?.configuration),
    };
  });
}

function configurationKeys(configuration: unknown): string[] {
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  return sections.flatMap((section) => {
    const properties = (section as { readonly properties?: unknown } | undefined)?.properties;
    return properties && typeof properties === "object" ? Object.keys(properties) : [];
  });
}
