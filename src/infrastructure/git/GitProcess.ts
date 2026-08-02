import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import {
  readConfiguredGitPaths,
  readGitTimeoutMilliseconds,
} from "../../config/extensionConfiguration";
import { pathIdentityKey } from "../../domain/pathValidation";
import { selectGitBinaryPath } from "./gitBinary";
import {
  buildLocalOnlyGitArguments,
  buildLocalOnlyGitEnvironment,
  isFilterInertGitInvocation,
  parseConfiguredFilterDrivers,
} from "./gitProcessPolicy";
import { GitScheduler } from "./GitScheduler";
import { SingleFlight } from "./singleFlight";

const execFileAsync = promisify(execFile);

const MAX_GIT_INPUT_BYTES = 5 * 1_024 * 1_024;
const MAX_GIT_OUTPUT_BYTES = 5 * 1_024 * 1_024;
const MAX_FILTER_CONFIG_OUTPUT_BYTES = 256 * 1_024;
const FILTER_CONFIG_QUERY = [
  "config",
  "--includes",
  "--name-only",
  "--null",
  "--get-regexp",
  "^filter\\.",
] as const;
const scheduler = new GitScheduler(4, 2);
const filterConfigurationProbes = new SingleFlight<string>();

let cachedGitBinary: string | undefined;
let filterProbeObserver: ((report: GitFilterProbeReport) => void) | undefined;

export interface GitFilterProbeReport {
  readonly durationMs: number;
  readonly sharedCommands: number;
}

/** Observes completed filter-configuration probes for diagnostic timing logs. */
export function setGitFilterProbeObserver(observer?: (report: GitFilterProbeReport) => void): void {
  filterProbeObserver = observer;
}

/**
 * Resolves and memoizes the absolute Git executable. Resolution reads the
 * user's configured `git.path` and probes `PATH`; a window reload re-resolves.
 */
function gitBinary(): string {
  cachedGitBinary ??= selectGitBinaryPath(readConfiguredGitPaths(), {
    isExecutableFile: isRegularFile,
    pathExtValue: process.env.PATHEXT,
    pathValue: process.env.PATH,
    platform: process.platform,
  });
  return cachedGitBinary;
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Reads the effective system/global/repository filter configuration, then
 * adds command-scoped no-op overrides for every executable filter driver.
 * The probe is a read-only Git builtin and cannot itself invoke a filter.
 * Provably filter-inert plumbing skips the probe, and commands that run
 * concurrently on one repository share a single in-flight probe.
 */
async function buildProtectedGitArguments(cwd: string, args: readonly string[]): Promise<string[]> {
  if (isFilterInertGitInvocation(args)) return buildLocalOnlyGitArguments(args);
  const output = await filterConfigurationProbes.run(
    pathIdentityKey(cwd),
    () => readFilterConfiguration(cwd),
    ({ durationMs, sharedCallers }) =>
      filterProbeObserver?.({ durationMs, sharedCommands: sharedCallers }),
  );
  return buildLocalOnlyGitArguments(args, parseConfiguredFilterDrivers(output));
}

/**
 * The shared probe deliberately runs without a caller's abort signal so one
 * cancelled command cannot fail the concurrent commands coalesced onto the
 * same probe; its runtime stays bounded by the configured Git timeout.
 */
async function readFilterConfiguration(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      gitBinary(),
      buildLocalOnlyGitArguments(FILTER_CONFIG_QUERY),
      {
        cwd,
        env: buildLocalOnlyGitEnvironment(process.env),
        maxBuffer: MAX_FILTER_CONFIG_OUTPUT_BYTES,
        timeout: readGitTimeoutMilliseconds(),
        windowsHide: true,
      },
    );
    return stdout;
  } catch (error) {
    const candidate = error as { readonly code?: unknown; readonly killed?: unknown };
    // `git config --get-regexp` uses exit 1 for a valid empty result.
    if (candidate.code !== 1 || candidate.killed === true) {
      throw normalizeGitError(error);
    }
    return "";
  }
}

/** Test seam: clears the memoized Git binary so a new environment is resolved. */
export function resetGitBinaryPathCache(): void {
  cachedGitBinary = undefined;
}

export type GitOperationErrorCode = "commandCancelled" | "commandTimedOut" | "outputTooLarge";

/** Stable process-control failure exposed by the Git infrastructure boundary. */
export class GitOperationError extends Error {
  public constructor(
    public readonly code: GitOperationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitOperationError";
  }
}

/** Executes a local-only Git command and decodes stdout as UTF-8 text. */
export function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
): Promise<string> {
  return scheduler.run(
    pathIdentityKey(cwd),
    async () => {
      try {
        const protectedArgs = await buildProtectedGitArguments(cwd, args);
        const { stdout } = await execFileAsync(gitBinary(), protectedArgs, {
          cwd,
          env: buildLocalOnlyGitEnvironment(process.env),
          maxBuffer: maxOutputBytes,
          signal,
          timeout: readGitTimeoutMilliseconds(),
          windowsHide: true,
        });
        return stdout;
      } catch (error) {
        throw normalizeGitError(error);
      }
    },
    signal,
  );
}

/**
 * Executes Git where listed non-zero exit codes carry data instead of
 * failure — e.g. `merge-tree --write-tree` exits 1 when the merge would
 * conflict and still prints the conflicted paths on stdout.
 */
export function runGitWithExitCode(
  cwd: string,
  args: readonly string[],
  acceptedExitCodes: readonly number[],
  signal?: AbortSignal,
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  return scheduler.run(
    pathIdentityKey(cwd),
    async () => {
      try {
        const protectedArgs = await buildProtectedGitArguments(cwd, args);
        const { stdout } = await execFileAsync(gitBinary(), protectedArgs, {
          cwd,
          env: buildLocalOnlyGitEnvironment(process.env),
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          signal,
          timeout: readGitTimeoutMilliseconds(),
          windowsHide: true,
        });
        return { exitCode: 0, stdout };
      } catch (error) {
        const candidate = error as {
          readonly code?: unknown;
          readonly killed?: unknown;
          readonly stdout?: unknown;
        };
        if (
          candidate.killed !== true &&
          typeof candidate.code === "number" &&
          acceptedExitCodes.includes(candidate.code) &&
          typeof candidate.stdout === "string"
        ) {
          return { exitCode: candidate.code, stdout: candidate.stdout };
        }
        throw normalizeGitError(error);
      }
    },
    signal,
  );
}

/** Executes Git and preserves binary stdout for immutable blob or patch content. */
export function runGitBuffer(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
): Promise<Buffer> {
  return scheduler.run(
    pathIdentityKey(cwd),
    async () => {
      try {
        const protectedArgs = await buildProtectedGitArguments(cwd, args);
        const { stdout } = await execFileAsync(gitBinary(), protectedArgs, {
          cwd,
          encoding: "buffer",
          env: buildLocalOnlyGitEnvironment(process.env),
          maxBuffer: maxOutputBytes,
          signal,
          timeout: readGitTimeoutMilliseconds(),
          windowsHide: true,
        });
        return stdout;
      } catch (error) {
        throw normalizeGitError(error);
      }
    },
    signal,
  );
}

export interface GitInputOptions {
  readonly maxInputBytes?: number;
  readonly temporaryIndex?: string;
}

/** Executes Git while optionally feeding bounded text or binary input to stdin. */
export function runGitWithInput(
  cwd: string,
  args: readonly string[],
  input: Buffer | string | undefined,
  signal?: AbortSignal,
  options: GitInputOptions = {},
): Promise<string> {
  const maxInputBytes = options.maxInputBytes ?? MAX_GIT_INPUT_BYTES;
  const inputBytes =
    input === undefined
      ? 0
      : typeof input === "string"
        ? Buffer.byteLength(input, "utf8")
        : input.byteLength;
  if (inputBytes > maxInputBytes) {
    return Promise.reject(new Error("The Git operation input is too large to process safely."));
  }
  if (
    options.temporaryIndex !== undefined &&
    (!isAbsolute(options.temporaryIndex) || options.temporaryIndex.includes("\0"))
  ) {
    return Promise.reject(new Error("The temporary Git index path is invalid."));
  }
  return scheduler.run(
    pathIdentityKey(cwd),
    async () => {
      const protectedArgs = await buildProtectedGitArguments(cwd, args);
      return new Promise((resolve, reject) => {
        const child = execFile(
          gitBinary(),
          protectedArgs,
          {
            cwd,
            env: {
              ...buildLocalOnlyGitEnvironment(process.env),
              ...(options.temporaryIndex ? { GIT_INDEX_FILE: options.temporaryIndex } : undefined),
            },
            maxBuffer: MAX_GIT_OUTPUT_BYTES,
            signal,
            timeout: readGitTimeoutMilliseconds(),
            windowsHide: true,
          },
          (error, stdout) => {
            if (error) reject(normalizeGitError(error));
            else resolve(stdout);
          },
        );
        if (input !== undefined && child.stdin) {
          child.stdin.on("error", () => {
            // Git may exit before consuming stdin; the exec callback reports it.
          });
          child.stdin.end(input);
        }
      });
    },
    signal,
  );
}

/** Executes a protected Git command against an isolated absolute index path. */
export function runGitWithTemporaryIndex(
  cwd: string,
  args: readonly string[],
  temporaryIndex: string,
  signal?: AbortSignal,
): Promise<string> {
  return runGitWithInput(cwd, args, undefined, signal, { temporaryIndex });
}

/** Normalizes platform-specific child-process failures into stable error codes. */
export function normalizeGitError(error: unknown): Error {
  if (error instanceof GitOperationError) return error;
  const candidate = error as {
    readonly code?: unknown;
    readonly killed?: unknown;
    readonly name?: unknown;
  };
  if (candidate.name === "AbortError") {
    return new GitOperationError("commandCancelled", "The Git operation was cancelled.", {
      cause: error,
    });
  }
  if (candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new GitOperationError(
      "outputTooLarge",
      "Git produced more output than RefHaven can safely process.",
      { cause: error },
    );
  }
  if (candidate.killed === true) {
    return new GitOperationError("commandTimedOut", "The Git operation timed out.", {
      cause: error,
    });
  }
  return error instanceof Error ? error : new Error("Git invocation failed.");
}
