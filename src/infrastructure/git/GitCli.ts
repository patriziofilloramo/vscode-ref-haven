import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as vscode from "vscode";

import type { LineBlame } from "../../domain/blame";
import type { BranchRef, RepositoryIdentity } from "../../domain/comparison";
import type { CommitInfo, FileChange } from "../../domain/comparisonResult";
import type { StashEntry } from "../../domain/stash";
import { pathIdentityKey } from "../../domain/pathValidation";
import { parseBlamePorcelain } from "./blamePorcelain";
import { parseBranchRefs } from "./branchRefs";
import { COMMIT_LOG_FORMAT, parseCommitLog } from "./commitLog";
import { parseNameStatusZ } from "./nameStatus";
import { mergeChangesWithStats, parseNumstatZ } from "./numstat";
import { STASH_LOG_FORMAT, parseStashList } from "./stashList";
import { GitScheduler } from "./GitScheduler";
import { buildLocalOnlyGitArguments, buildLocalOnlyGitEnvironment } from "./gitProcessPolicy";
import { buildRepositoryIdentities } from "./repositoryDiscovery";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_GIT_INPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_SECONDS = 30;
const MAX_GIT_TIMEOUT_SECONDS = 300;
const scheduler = new GitScheduler(4, 2);

export type GitOperationErrorCode = "commandCancelled" | "commandTimedOut" | "outputTooLarge";

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

interface GitApiRepository {
  readonly rootUri: vscode.Uri;
}

interface GitApi {
  readonly repositories: readonly GitApiRepository[];
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export async function discoverRepositories(signal?: AbortSignal): Promise<RepositoryIdentity[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const gitRoots = discoverFromGitExtension();
  const fallbackRoots = await Promise.all(
    folders.map(async (folder) => {
      const root = await runGit(folder.uri.fsPath, ["rev-parse", "--show-toplevel"], signal).catch(
        () => null,
      );
      const trimmed = root?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : null;
    }),
  );

  return buildRepositoryIdentities(
    [...gitRoots, ...fallbackRoots].filter((root): root is string => root !== null),
    folders.map((folder) => ({
      name: folder.name,
      rootPath: folder.uri.fsPath,
      uri: folder.uri.toString(),
    })),
  );
}

export async function listBranchRefs(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<BranchRef[]> {
  const stdout = await runGit(
    repositoryRoot,
    ["for-each-ref", "--format=%(refname)%09%(refname:short)", "refs/heads", "refs/remotes"],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not list the branches for this repository."),
  );
  return parseBranchRefs(stdout);
}

export async function readCurrentBranch(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const stdout = await runGit(
    repositoryRoot,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    signal,
  ).catch(() => null);
  const branchName = stdout?.trim();
  return branchName && branchName.length > 0 ? branchName : null;
}

export async function resolveRef(
  repositoryRoot: string,
  fullName: string,
  signal?: AbortSignal,
): Promise<string> {
  const stdout = await runGit(
    repositoryRoot,
    ["rev-parse", "--verify", `${fullName}^{commit}`],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "A selected branch no longer exists or cannot be resolved."),
  );
  return parseObjectId(stdout, `Could not resolve ${fullName}.`);
}

export async function findMergeBase(
  repositoryRoot: string,
  baseSha: string,
  targetSha: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const stdout = await runGit(repositoryRoot, ["merge-base", baseSha, targetSha], signal).catch(
    (error: unknown) => preserveControlErrorOrNull(error),
  );
  return stdout === null ? null : parseObjectId(stdout, "Git returned an invalid merge base.");
}

export async function listChangedFiles(
  repositoryRoot: string,
  fromSha: string,
  toSha: string,
  signal?: AbortSignal,
): Promise<FileChange[]> {
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGit(
      repositoryRoot,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        "-z",
        "--find-renames",
        fromSha,
        toSha,
        "--",
      ],
      signal,
    ),
    runGit(
      repositoryRoot,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        "--find-renames",
        fromSha,
        toSha,
        "--",
      ],
      signal,
    ),
  ]).catch((error: unknown) =>
    failGitOperation(error, "Git could not calculate the changed files for this comparison."),
  );
  return mergeChangesWithStats(parseNameStatusZ(nameStatusOutput), parseNumstatZ(numstatOutput));
}

export async function countAheadBehind(
  repositoryRoot: string,
  baseSha: string,
  targetSha: string,
  signal?: AbortSignal,
): Promise<{ readonly ahead: number; readonly behind: number }> {
  const stdout = await runGit(
    repositoryRoot,
    ["rev-list", "--left-right", "--count", `${baseSha}...${targetSha}`],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not count the commits between these branches."),
  );
  const match = /^(\d+)\s+(\d+)/.exec(stdout.trim());
  const behind = match?.[1];
  const ahead = match?.[2];
  if (behind === undefined || ahead === undefined) {
    throw new Error("Git returned an invalid ahead/behind count.");
  }
  return { ahead: Number.parseInt(ahead, 10), behind: Number.parseInt(behind, 10) };
}

/** Lists commits reachable from `toSha` but not from `fromSha`, newest first. */
export async function listCommitRange(
  repositoryRoot: string,
  fromSha: string,
  toSha: string,
  limit: number,
  signal?: AbortSignal,
): Promise<CommitInfo[]> {
  const stdout = await runGit(
    repositoryRoot,
    [
      "log",
      `--max-count=${limit.toString()}`,
      `--format=${COMMIT_LOG_FORMAT}`,
      `${fromSha}..${toSha}`,
      "--",
    ],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not list the commits between these branches."),
  );
  return parseCommitLog(stdout);
}

export interface CommitFileChanges {
  readonly files: FileChange[];
  /** First parent SHA, or null when the commit is a root commit. */
  readonly parentSha: string | null;
}

/** Lists the files a single commit changed relative to its first parent. */
export async function listCommitFileChanges(
  repositoryRoot: string,
  sha: string,
  signal?: AbortSignal,
): Promise<CommitFileChanges> {
  const parentOutput = await runGit(
    repositoryRoot,
    ["rev-parse", "--verify", "--quiet", `${sha}^`],
    signal,
  ).catch((error: unknown) => preserveControlErrorOrNull(error));
  if (parentOutput !== null) {
    const parentSha = parseObjectId(parentOutput, "Git returned an invalid parent commit.");
    return { files: await listChangedFiles(repositoryRoot, parentSha, sha, signal), parentSha };
  }

  const diffTreeArgs = [
    "diff-tree",
    "--no-ext-diff",
    "--no-textconv",
    "--no-commit-id",
    "-r",
    "-z",
    "--root",
    "--find-renames",
  ];
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGit(repositoryRoot, [...diffTreeArgs, "--name-status", sha, "--"], signal),
    runGit(repositoryRoot, [...diffTreeArgs, "--numstat", sha, "--"], signal),
  ]).catch((error: unknown) =>
    failGitOperation(error, "Git could not calculate the changed files for this commit."),
  );
  return {
    files: mergeChangesWithStats(parseNameStatusZ(nameStatusOutput), parseNumstatZ(numstatOutput)),
    parentSha: null,
  };
}

export async function listStashes(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<StashEntry[]> {
  const stdout = await runGit(
    repositoryRoot,
    ["stash", "list", `--format=${STASH_LOG_FORMAT}`],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not list the stashes for this repository."),
  );
  return parseStashList(stdout);
}

/** Resolves the repository root containing `directory`, or null outside a repo. */
export async function findRepositoryRoot(directory: string): Promise<string | null> {
  const stdout = await runGit(directory, ["rev-parse", "--show-toplevel"]).catch(() => null);
  const rootPath = stdout?.trim();
  return rootPath && rootPath.length > 0 ? rootPath : null;
}

export async function readGitUserName(repositoryRoot: string): Promise<string | null> {
  const stdout = await runGit(repositoryRoot, ["config", "user.name"]).catch(() => null);
  const userName = stdout?.trim();
  return userName && userName.length > 0 ? userName : null;
}

/**
 * Blames a single one-based line of a repository-relative file. Pass
 * `contents` to blame an unsaved buffer instead of the on-disk file. Returns
 * null when Git cannot blame the line (e.g. untracked files).
 */
export async function blameLine(
  repositoryRoot: string,
  filePath: string,
  line: number,
  contents?: string,
  signal?: AbortSignal,
): Promise<LineBlame | null> {
  const args = [
    "blame",
    "--porcelain",
    "-L",
    `${line.toString()},${line.toString()}`,
    ...(contents === undefined ? [] : ["--contents", "-"]),
    "--",
    filePath,
  ];
  const stdout = await runGitWithInput(repositoryRoot, args, contents, signal).catch(() => null);
  if (stdout === null) return null;
  try {
    return parseBlamePorcelain(stdout);
  } catch {
    return null;
  }
}

export async function readFileAtRevision(
  repositoryRoot: string,
  sha: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    return await runGitBuffer(repositoryRoot, ["show", `${sha}:${filePath}`], signal);
  } catch (error) {
    const normalized = normalizeGitError(error);
    if (normalized instanceof GitOperationError) throw normalized;
    throw new Error("Git could not read this file revision.", { cause: error });
  }
}

export async function resolveGitMetadataPaths(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const [gitDir, commonDir] = await Promise.all([
    runGit(repositoryRoot, ["rev-parse", "--absolute-git-dir"], signal),
    runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
  ]);
  return [
    ...new Map(
      [gitDir, commonDir].map((value) => {
        const path = value.trim();
        return [pathIdentityKey(path), path] as const;
      }),
    ).values(),
  ];
}

async function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return scheduler.run(
    pathIdentityKey(cwd),
    async () => {
      try {
        const { stdout } = await execFileAsync("git", buildLocalOnlyGitArguments(args), {
          cwd,
          env: buildLocalOnlyGitEnvironment(process.env),
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          signal,
          timeout: gitTimeoutMs(),
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

async function runGitBuffer(
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
          timeout: gitTimeoutMs(),
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

/** Like {@link runGit}, but optionally feeds `input` to Git's stdin. */
function runGitWithInput(
  cwd: string,
  args: readonly string[],
  input: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (input !== undefined && Buffer.byteLength(input, "utf8") > MAX_GIT_INPUT_BYTES) {
    return Promise.reject(new Error("The active document is too large for inline blame."));
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
            env: buildLocalOnlyGitEnvironment(process.env),
            maxBuffer: MAX_GIT_OUTPUT_BYTES,
            signal,
            timeout: gitTimeoutMs(),
            windowsHide: true,
          },
          (error, stdout) => {
            if (error) {
              reject(normalizeGitError(error));
            } else resolve(stdout);
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

function parseObjectId(stdout: string, errorMessage: string): string {
  const objectId = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(objectId)) throw new Error(errorMessage);
  return objectId;
}

function discoverFromGitExtension(): string[] {
  try {
    const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!extension?.isActive) return [];
    const exports = extension.exports;
    if (!exports.enabled) return [];
    return exports.getAPI(1).repositories.map(({ rootUri }) => rootUri.fsPath);
  } catch {
    return [];
  }
}

function gitTimeoutMs(): number {
  const configured = vscode.workspace
    .getConfiguration("branchCompare")
    .get<number>("git.timeoutSeconds", DEFAULT_GIT_TIMEOUT_SECONDS);
  const seconds = Number.isFinite(configured)
    ? Math.min(MAX_GIT_TIMEOUT_SECONDS, Math.max(1, configured))
    : DEFAULT_GIT_TIMEOUT_SECONDS;
  return seconds * 1000;
}

function normalizeGitError(error: unknown): Error {
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
      "Git produced more output than Branch Compare can safely process.",
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

function failGitOperation(error: unknown, safeMessage: string): never {
  const normalized = normalizeGitError(error);
  if (normalized instanceof GitOperationError) throw normalized;
  throw new Error(safeMessage, { cause: normalized });
}

function preserveControlErrorOrNull(error: unknown): null {
  const normalized = normalizeGitError(error);
  if (normalized instanceof GitOperationError) throw normalized;
  return null;
}
