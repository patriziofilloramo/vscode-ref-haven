import * as vscode from "vscode";

import {
  EXTENSION_CONFIGURATION_SECTION,
  EXTENSION_SETTING_DEFAULTS,
  EXTENSION_SETTING_LIMITS,
  EXTENSION_SETTINGS,
  type ExtensionSetting,
} from "./extensionConfigurationSchema";

export {
  EXTENSION_CONFIGURATION_SECTION,
  EXTENSION_SETTING_DEFAULTS,
  EXTENSION_SETTING_LIMITS,
  EXTENSION_SETTINGS,
  extensionSettingPath,
  type ExtensionSetting,
} from "./extensionConfigurationSchema";

/** Returns the RefHaven configuration scoped by VS Code to the active resource. */
export function getExtensionConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(EXTENSION_CONFIGURATION_SECTION);
}

/** Reads a typed setting with an explicit default. */
export function readExtensionSetting<T>(setting: ExtensionSetting, defaultValue: T): T {
  return getExtensionConfiguration().get<T>(setting, defaultValue);
}

/** Reads and clamps the Git timeout before converting it to milliseconds. */
export function readGitTimeoutMilliseconds(): number {
  const configured = readExtensionSetting<number>(
    EXTENSION_SETTINGS.gitTimeoutSeconds,
    EXTENSION_SETTING_DEFAULTS.gitTimeoutSeconds,
  );
  const { maximum, minimum } = EXTENSION_SETTING_LIMITS.gitTimeoutSeconds;
  const seconds = Number.isFinite(configured)
    ? Math.min(maximum, Math.max(minimum, configured))
    : EXTENSION_SETTING_DEFAULTS.gitTimeoutSeconds;
  return seconds * 1_000;
}
