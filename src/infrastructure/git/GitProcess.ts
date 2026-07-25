import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readGitTimeoutMilliseconds } from "../../config/extensionConfiguration";
import { pathIdentityKey } from "../../domain/pathValidation";
import { buildLocalOnlyGitArguments, buildLocalOnlyGitEnvironment } from "./gitProcessPolicy";
import { GitScheduler } from "./GitScheduler";

const execFileAsync = promisify(execFile);

const MAX_GIT_INPUT_BYTES = 5 * 1_024 * 1_024;
const MAX_GIT_OUTPUT_BYTES = 5 * 1_024 * 1_024;
const scheduler = new GitScheduler(4, 2);

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
        const { stdout } = await execFileAsync("git", buildLocalOnlyGitArguments(args), {
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

/** Executes Git with a temporary index without changing the inherited environment. */
export function runGitWithTemporaryIndex(
  cwd: string,
  args: readonly string[],
  temporaryIndex: string,
  signal?: AbortSignal,
): Promise<string> {
  return scheduler.run(
    pathIdentityKey(cwd),
    async () => {
      try {
        const { stdout } = await execFileAsync("git", buildLocalOnlyGitArguments(args), {
          cwd,
          env: {
            ...buildLocalOnlyGitEnvironment(process.env),
            GIT_INDEX_FILE: temporaryIndex,
          },
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
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

/** Executes Git and preserves binary stdout for immutable blob content. */
export function runGitBuffer(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  return scheduler.run(
    pathIdentityKey(cwd),
    async () => {
      try {
        const { stdout } = await execFileAsync("git", buildLocalOnlyGitArguments(args), {
          cwd,
          encoding: "buffer",
          env: buildLocalOnlyGitEnvironment(process.env),
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
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

/** Executes Git while optionally feeding bounded UTF-8 input to stdin. */
export function runGitWithInput(
  cwd: string,
  args: readonly string[],
  input: string | undefined,
  signal?: AbortSignal,
  temporaryIndex?: string,
): Promise<string> {
  if (input !== undefined && Buffer.byteLength(input, "utf8") > MAX_GIT_INPUT_BYTES) {
    return Promise.reject(new Error("The Git operation input is too large to process safely."));
  }
  return scheduler.run(
    pathIdentityKey(cwd),
    () =>
      new Promise((resolve, reject) => {
        const child = execFile(
          "git",
          buildLocalOnlyGitArguments(args),
          {
            cwd,
            env: {
              ...buildLocalOnlyGitEnvironment(process.env),
              ...(temporaryIndex ? { GIT_INDEX_FILE: temporaryIndex } : {}),
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
      }),
    signal,
  );
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
