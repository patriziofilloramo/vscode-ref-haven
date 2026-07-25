/**
 * Line intelligence is the group of always-on, per-line surfaces: the
 * end-of-line blame decoration, the line hover, and the status-bar entry.
 *
 * They are grouped because they conflict as a group. VS Code renders every
 * extension's decorations and merges every extension's hovers, so a second
 * blame extension does not replace ours — it doubles it. One switch turns the
 * overlap off; three separate settings make the user hunt for it.
 */
export type LineIntelligenceMode = "full" | "hoverOnly" | "off";

export interface LineIntelligenceSettings {
  readonly inlineBlame: boolean;
  readonly lineHover: boolean;
  readonly statusBar: boolean;
}

export function lineIntelligenceSettings(mode: LineIntelligenceMode): LineIntelligenceSettings {
  switch (mode) {
    case "full":
      return { inlineBlame: true, lineHover: true, statusBar: true };
    // The hover survives because it is the surface where overlap costs least:
    // two hovers stack in one widget, while two decorations collide on the
    // same line and two status-bar entries claim the same strip.
    case "hoverOnly":
      return { inlineBlame: false, lineHover: true, statusBar: false };
    case "off":
      return { inlineBlame: false, lineHover: false, statusBar: false };
  }
}

export function lineIntelligenceMode(settings: LineIntelligenceSettings): LineIntelligenceMode {
  for (const mode of ["full", "hoverOnly", "off"] as const) {
    const candidate = lineIntelligenceSettings(mode);
    if (
      candidate.inlineBlame === settings.inlineBlame &&
      candidate.lineHover === settings.lineHover &&
      candidate.statusBar === settings.statusBar
    ) {
      return mode;
    }
  }
  return "full";
}

/** The parts of an installed extension's manifest this detection reads. */
export interface InstalledExtensionManifest {
  readonly id: string;
  readonly commandIds: readonly string[];
  readonly commandTitles: readonly string[];
  readonly settingKeys: readonly string[];
}

// Matches `blame`, `toggleBlame`, and `vendor.blame.format`, but not
// `blameless` or `unblamed`: a trailing letter makes it a different word.
const BLAME_CAPABILITY = /blame(?![a-z])/iu;

/**
 * Reports whether another installed extension contributes a blame surface.
 *
 * Detection reads what an extension *declares it does*, never who publishes
 * it: no competitor identifier is embedded here, so the check keeps working
 * as products come and go, and it names no one. It is deliberately a
 * capability heuristic — VS Code exposes no way to observe another
 * extension's decorations, so what is drawn on screen cannot be detected at
 * all, only what was contributed.
 *
 * A false positive costs one dismissible notice, so the check errs toward
 * informing. Nothing is disabled on its own: a user who installed RefHaven
 * may well be replacing the other extension, and silently switching off its
 * most visible feature would be the worse guess.
 */
export function hasOtherBlameExtension(
  extensions: readonly InstalledExtensionManifest[],
  ownId: string,
): boolean {
  return extensions.some(
    ({ commandIds, commandTitles, id, settingKeys }) =>
      id.toLowerCase() !== ownId.toLowerCase() &&
      [...commandIds, ...commandTitles, ...settingKeys].some((value) =>
        BLAME_CAPABILITY.test(value),
      ),
  );
}
