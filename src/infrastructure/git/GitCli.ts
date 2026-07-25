import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as vscode from "vscode";

import type { FileBlameLine, LineBlame } from "../../domain/blame";
import type { BranchRef, RepositoryIdentity } from "../../domain/comparison";
import type { CommitDetails, CommitSearchKind } from "../../domain/commitDetails";
import { COMMIT_PAGE_SIZE, type CommitInfo, type FileChange } from "../../domain/comparisonResult";
import type { FileHistoryEntry } from "../../domain/history";
import type { ChangedLineRange } from "../../domain/fileAnnotations";
import { assertRepositoryRelativeGitPath, pathIdentityKey } from "../../domain/pathValidation";
import type { StashEntry } from "../../domain/stash";
import type { WorktreeInfo } from "../../domain/worktree";
import { parseBlameFilePorcelain, parseBlamePorcelain } from "./blamePorcelain";
import { parseBranchRefs, parseComparisonRefs } from "./branchRefs";
import { COMMIT_LOG_FORMAT, parseCommitLog } from "./commitLog";
import { COMMIT_DETAILS_FORMAT, parseCommitDetails } from "./commitDetails";
import { parseChangedLineRanges } from "./diffHunks";
import { FILE_HISTORY_LOG_FORMAT, parseFileHistory } from "./fileHistory";
import { parseNameStatusZ } from "./nameStatus";
import { mergeChangesWithStats, parseNumstatZ } from "./numstat";
import { STASH_LOG_FORMAT, parseStashList } from "./stashList";
import { parseWorktreeList } from "./worktreeList";
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

export async function listComparisonRefs(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<BranchRef[]> {
  const stdout = await runGit(
    repositoryRoot,
    [
      "for-each-ref",
      "--format=%(refname)%09%(refname:short)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not list the references for this repository."),
  );
  return [{ displayName: "HEAD", fullName: "HEAD", kind: "head" }, ...parseComparisonRefs(stdout)];
}

export async function listWorktrees(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<WorktreeInfo[]> {
  const stdout = await runGit(
    repositoryRoot,
    ["worktree", "list", "--porcelain", "-z"],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not list the repository worktrees."),
  );
  return parseWorktreeList(stdout);
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
    ["rev-parse", "--verify", "--end-of-options", `${fullName}^{commit}`],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "The selected reference no longer exists or cannot be resolved."),
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

export async function listWorkingTreeChanges(
  repositoryRoot: string,
  fromSha: string,
  signal?: AbortSignal,
): Promise<FileChange[]> {
  const baseArgs = ["diff", "--no-ext-diff", "--no-textconv"];
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGit(
      repositoryRoot,
      [...baseArgs, "--name-status", "-z", "--find-renames", fromSha, "--"],
      signal,
    ),
    runGit(
      repositoryRoot,
      [...baseArgs, "--numstat", "-z", "--find-renames", fromSha, "--"],
      signal,
    ),
  ]).catch((error: unknown) => failGitOperation(error, "Git could not compare the working tree."));
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

export async function listFileHistory(
  repositoryRoot: string,
  filePath: string,
  limit = COMMIT_PAGE_SIZE,
  signal?: AbortSignal,
): Promise<FileHistoryEntry[]> {
  assertRepositoryRelativeGitPath(filePath);
  const stdout = await runGit(
    repositoryRoot,
    [
      "log",
      "--follow",
      `--max-count=${limit.toString()}`,
      `--format=${FILE_HISTORY_LOG_FORMAT}`,
      "--name-status",
      "-z",
      "--find-renames",
      "--",
      filePath,
    ],
    signal,
  ).catch((error: unknown) => failGitOperation(error, "Git could not load the file history."));
  return parseFileHistory(stdout);
}

export async function listLineHistory(
  repositoryRoot: string,
  filePath: string,
  startLine: number,
  endLine: number,
  limit = COMMIT_PAGE_SIZE,
  signal?: AbortSignal,
): Promise<CommitInfo[]> {
  assertRepositoryRelativeGitPath(filePath);
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new Error("The selected line range is invalid.");
  }
  const stdout = await runGit(
    repositoryRoot,
    [
      "log",
      "--no-patch",
      `--max-count=${limit.toString()}`,
      `--format=${COMMIT_LOG_FORMAT}`,
      "-L",
      `${startLine.toString()},${endLine.toString()}:${filePath}`,
    ],
    signal,
  ).catch((error: unknown) => failGitOperation(error, "Git could not load the line history."));
  return parseCommitLog(stdout);
}

export async function readCommitDetails(
  repositoryRoot: string,
  sha: string,
  signal?: AbortSignal,
): Promise<CommitDetails> {
  const stdout = await runGit(
    repositoryRoot,
    ["show", "--no-patch", `--format=${COMMIT_DETAILS_FORMAT}`, sha],
    signal,
  ).catch((error: unknown) => failGitOperation(error, "Git could not load the commit details."));
  return parseCommitDetails(stdout);
}

export async function searchCommits(
  repositoryRoot: string,
  kind: CommitSearchKind,
  query: string,
  limit = COMMIT_PAGE_SIZE,
  signal?: AbortSignal,
): Promise<CommitInfo[]> {
  if (query.length === 0 || query.length > 512 || query.includes("\0")) {
    throw new Error("The commit search query is invalid.");
  }
  if (kind === "sha") {
    if (!/^[0-9a-f]{4,64}$/iu.test(query)) return [];
    const sha = await resolveRef(repositoryRoot, query, signal).catch(() => null);
    if (!sha) return [];
    const details = await readCommitDetails(repositoryRoot, sha, signal);
    return [details.commit];
  }
  const criterion =
    kind === "message"
      ? ["--regexp-ignore-case", `--grep=${query}`]
      : kind === "author"
        ? [`--author=${query}`]
        : [`-S${query}`, "--pickaxe-all"];
  const stdout = await runGit(
    repositoryRoot,
    [
      "log",
      "--all",
      `--max-count=${limit.toString()}`,
      `--format=${COMMIT_LOG_FORMAT}`,
      ...criterion,
      "--",
    ],
    signal,
  ).catch((error: unknown) => failGitOperation(error, "Git could not search the local commits."));
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
  assertRepositoryRelativeGitPath(filePath);
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

export async function blameFile(
  repositoryRoot: string,
  filePath: string,
  contents?: string,
  signal?: AbortSignal,
): Promise<FileBlameLine[]> {
  assertRepositoryRelativeGitPath(filePath);
  const args = [
    "blame",
    "--line-porcelain",
    "--root",
    ...(contents === undefined ? [] : ["--contents", "-"]),
    "--",
    filePath,
  ];
  const stdout = await runGitWithInput(repositoryRoot, args, contents, signal).catch(
    (error: unknown) => failGitOperation(error, "Git could not annotate this file."),
  );
  return parseBlameFilePorcelain(stdout);
}

export async function listChangedLineRanges(
  repositoryRoot: string,
  baseSha: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<ChangedLineRange[]> {
  assertRepositoryRelativeGitPath(filePath);
  if (!/^[0-9a-f]{40,64}$/u.test(baseSha)) throw new Error("The base commit SHA is invalid.");
  const stdout = await runGit(
    repositoryRoot,
    ["diff", "--no-ext-diff", "--no-textconv", "--unified=0", baseSha, "--", filePath],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not annotate changes for this file."),
  );
  return parseChangedLineRanges(stdout);
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
    .getConfiguration("refhaven")
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
