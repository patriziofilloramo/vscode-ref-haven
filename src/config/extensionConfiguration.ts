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

/**
 * Reads the Git executable path(s) configured for VS Code's built-in Git
 * extension (`git.path`). Used to resolve an absolute, trusted Git binary
 * instead of relying on `PATH` lookup. Non-string and empty entries are
 * dropped; validation of the paths happens where they are resolved.
 */
export function readConfiguredGitPaths(): string[] {
  const configured = vscode.workspace.getConfiguration("git").get<unknown>("path");
  if (typeof configured === "string") {
    return configured.length > 0 ? [configured] : [];
  }
  if (Array.isArray(configured)) {
    return configured.filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
  }
  return [];
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
