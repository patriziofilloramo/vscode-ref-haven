/** Root namespace used by every RefHaven setting. */
export const EXTENSION_CONFIGURATION_SECTION = "refhaven";

/** Relative setting names. Keep these aligned with `package.json`. */
export const EXTENSION_SETTINGS = {
  approvedGitLabOrigins: "gitLab.approvedOrigins",
  browserHostGrammar: "browserLinks.hostGrammar",
  fileAnnotationsMode: "fileAnnotations.mode",
  gitTimeoutSeconds: "git.timeoutSeconds",
  inlineBlameEnabled: "inlineBlame.enabled",
  lineHoverEnabled: "lineHover.enabled",
  statusBarBlameEnabled: "statusBarBlame.enabled",
} as const;

export type ExtensionSetting = (typeof EXTENSION_SETTINGS)[keyof typeof EXTENSION_SETTINGS];

/** Defaults shared by runtime code and manifest tests. */
export const EXTENSION_SETTING_DEFAULTS = {
  approvedGitLabOrigins: [] as readonly string[],
  browserHostGrammar: "auto",
  fileAnnotationsMode: "off",
  gitTimeoutSeconds: 30,
  inlineBlameEnabled: true,
  lineHoverEnabled: true,
  statusBarBlameEnabled: true,
} as const;

/** Bounds shared by runtime validation and manifest tests. */
export const EXTENSION_SETTING_LIMITS = {
  gitTimeoutSeconds: { maximum: 300, minimum: 1 },
} as const;

/** Returns a fully-qualified setting name. */
export function extensionSettingPath(setting: ExtensionSetting): string {
  return `${EXTENSION_CONFIGURATION_SECTION}.${setting}`;
}
