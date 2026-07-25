import { posix as pathPosix, win32 as pathWin32 } from "node:path";

/**
 * Host facts and a filesystem probe, injected so selection stays pure and
 * host-independent for testing.
 */
export interface GitBinaryEnvironment {
  readonly isExecutableFile: (candidate: string) => boolean;
  readonly pathValue: string | undefined;
  readonly pathExtValue: string | undefined;
  readonly platform: NodeJS.Platform;
}

const WINDOWS_DEFAULT_EXECUTABLE_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

/**
 * Resolves the Git executable to an absolute path so that a poisoned `PATH`,
 * or the current working directory leaking in through an empty `PATH` entry on
 * Windows, cannot substitute an attacker-controlled binary for `git`.
 *
 * Configured absolute paths win first; otherwise each absolute `PATH`
 * directory is probed for a real `git` file. The bare name `git` is returned
 * only when nothing resolves, preserving today's behaviour on unusual setups
 * rather than breaking Git access.
 */
export function selectGitBinaryPath(
  configuredPaths: readonly string[],
  environment: GitBinaryEnvironment,
): string {
  const pathApi = environment.platform === "win32" ? pathWin32 : pathPosix;

  for (const configured of configuredPaths) {
    if (pathApi.isAbsolute(configured) && environment.isExecutableFile(configured)) {
      return configured;
    }
  }

  const executableNames = gitExecutableNames(environment);
  for (const directory of (environment.pathValue ?? "").split(pathApi.delimiter)) {
    // An empty entry resolves to the current directory (notably on Windows),
    // and a relative entry is equally untrustworthy, so only absolute
    // directories are probed.
    if (directory.length === 0 || !pathApi.isAbsolute(directory)) continue;
    for (const name of executableNames) {
      const candidate = pathApi.join(directory, name);
      if (environment.isExecutableFile(candidate)) return candidate;
    }
  }

  return "git";
}

function gitExecutableNames(environment: GitBinaryEnvironment): string[] {
  if (environment.platform !== "win32") return ["git"];

  const configuredExtensions = (environment.pathExtValue ?? "")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.startsWith("."));
  const extensions =
    configuredExtensions.length > 0 ? configuredExtensions : WINDOWS_DEFAULT_EXECUTABLE_EXTENSIONS;

  const names = new Set<string>();
  for (const extension of extensions) names.add(`git${extension.toLowerCase()}`);
  // Git for Windows ships git.exe; guarantee it is probed even if PATHEXT omits it.
  names.add("git.exe");
  return [...names];
}
