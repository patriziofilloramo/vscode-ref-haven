import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as vscode from "vscode";

import type { FileBlameLine, LineBlame } from "../../domain/blame";
import type { BranchRef, RepositoryIdentity } from "../../domain/comparison";
import type { CommitDetails, CommitSearchKind } from "../../domain/commitDetails";
import { COMMIT_PAGE_SIZE, type CommitInfo, type FileChange } from "../../domain/comparisonResult";
import type { FileHistoryEntry } from "../../domain/history";
import { MAX_INTERACTIVE_INPUT_LENGTH, MAX_STASH_MESSAGE_LENGTH } from "../../domain/inputLimits";
import type { ChangedLineRange } from "../../domain/fileAnnotations";
import { isGitObjectId, requireGitObjectId } from "../../domain/gitObjectId";
import type { GitRemoteUrl } from "../../domain/browserLinks";
import type { BranchDetails, WorktreeState } from "../../domain/repositoryNavigation";
import {
  assertRepositoryRelativeGitPath,
  assertRepositoryWorktreeGitPath,
  pathIdentityKey,
  resolvePathWithinRepository,
} from "../../domain/pathValidation";
import type { StashEntry } from "../../domain/stash";
import type { WorktreeInfo } from "../../domain/worktree";
import { parseBlameFilePorcelain, parseBlamePorcelain } from "./blamePorcelain";
import { parseBranchRefs, parseComparisonRefs } from "./branchRefs";
import { BRANCH_DETAILS_FORMAT, parseBranchDetails } from "./branchDetails";
import { COMMIT_LOG_FORMAT, parseCommitLog } from "./commitLog";
import { COMMIT_DETAILS_FORMAT, parseCommitDetails } from "./commitDetails";
import { parseChangedLineRanges } from "./diffHunks";
import { FILE_HISTORY_LOG_FORMAT, parseFileHistory } from "./fileHistory";
import { parseNameStatusZ } from "./nameStatus";
import { mergeChangesWithStats, parseNumstatZ } from "./numstat";
import { STASH_LOG_FORMAT, parseStashList } from "./stashList";
import { parseWorktreeList } from "./worktreeList";
import { parseWorktreeStatus } from "./worktreeStatus";
import {
  GitOperationError,
  normalizeGitError,
  runGit,
  runGitBuffer,
  runGitWithInput,
  runGitWithTemporaryIndex,
} from "./GitProcess";
import { buildRepositoryIdentities } from "./repositoryDiscovery";

const MAX_HOVER_DIFF_BYTES = 64 * 1024;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
export { GitOperationError } from "./GitProcess";

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

export async function listBranchDetails(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<BranchDetails[]> {
  const stdout = await runGit(
    repositoryRoot,
    ["for-each-ref", `--format=${BRANCH_DETAILS_FORMAT}`, "refs/heads", "refs/remotes"],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not load branch details for this repository."),
  );
  return parseBranchDetails(stdout);
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

export async function listGitRemoteUrls(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<GitRemoteUrl[]> {
  const namesOutput = await runGit(repositoryRoot, ["remote"], signal).catch((error: unknown) =>
    failGitOperation(error, "Git could not list repository remotes."),
  );
  const names = namesOutput
    .split(/\r?\n/u)
    .filter((name) => isSafeRemoteName(name))
    .slice(0, 32);
  const remotes = await Promise.all(
    names.map(async (name) => {
      const urlsOutput = await runGit(repositoryRoot, ["remote", "get-url", "--all", name], signal);
      return urlsOutput
        .split(/\r?\n/u)
        .filter((url) => url.length > 0 && url.length <= 4_096)
        .slice(0, 8)
        .map((url) => ({ name, url }));
    }),
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not read repository remote URLs."),
  );
  return remotes.flat();
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

export async function readWorktreeState(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<WorktreeState> {
  const stdout = await runGit(
    worktreePath,
    ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal"],
    signal,
  ).catch((error: unknown) => failGitOperation(error, "Git could not read the worktree state."));
  return parseWorktreeStatus(stdout);
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

export async function listChangedFilesForPath(
  repositoryRoot: string,
  fromSha: string,
  toSha: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<FileChange[]> {
  assertRepositoryRelativeGitPath(filePath);
  const baseArgs = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", fromSha, toSha];
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGit(repositoryRoot, [...baseArgs, "--name-status", "-z", "--", filePath], signal),
    runGit(repositoryRoot, [...baseArgs, "--numstat", "-z", "--", filePath], signal),
  ]).catch((error: unknown) =>
    failGitOperation(error, "Git could not compare this file between the selected revisions."),
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

export async function listWorkingTreeFileChanges(
  repositoryRoot: string,
  fromSha: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<FileChange[]> {
  assertRepositoryRelativeGitPath(filePath);
  const baseArgs = ["diff", "--no-ext-diff", "--no-textconv"];
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGit(
      repositoryRoot,
      [...baseArgs, "--name-status", "-z", "--find-renames", fromSha, "--", filePath],
      signal,
    ),
    runGit(
      repositoryRoot,
      [...baseArgs, "--numstat", "-z", "--find-renames", fromSha, "--", filePath],
      signal,
    ),
  ]).catch((error: unknown) =>
    failGitOperation(error, "Git could not compare this file with the working tree."),
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

export async function listRecentCommits(
  repositoryRoot: string,
  revision: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<CommitInfo[]> {
  const sha = await resolveRef(repositoryRoot, revision, signal);
  const stdout = await runGit(
    repositoryRoot,
    [
      "log",
      `--max-count=${Math.max(1, Math.min(limit, COMMIT_PAGE_SIZE)).toString()}`,
      `--format=${COMMIT_LOG_FORMAT}`,
      sha,
      "--",
    ],
    signal,
  ).catch((error: unknown) =>
    failGitOperation(error, "Git could not load recent commits for this branch."),
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

export async function stashTrackedFile(
  repositoryRoot: string,
  filePath: string,
  message: string,
): Promise<string> {
  assertRepositoryWorktreeGitPath(filePath);
  const normalizedMessage = message.trim();
  if (
    normalizedMessage.length === 0 ||
    normalizedMessage.length > MAX_STASH_MESSAGE_LENGTH ||
    normalizedMessage.includes("\0")
  ) {
    throw new Error("The stash message must contain between 1 and 500 characters.");
  }

  const headSha = await resolveRef(repositoryRoot, "HEAD");
  const branchName = (await readCurrentBranch(repositoryRoot)) ?? "(no branch)";
  const stashSubject = `On ${branchName}: ${normalizedMessage}`;
  const workingTreeChanges = await listWorkingTreeChanges(repositoryRoot, headSha);
  const selectedChange = workingTreeChanges.find(
    ({ newPath, oldPath }) => newPath === filePath || oldPath === filePath,
  );
  const pathspecs =
    selectedChange?.status === "renamed" && selectedChange.oldPath
      ? [selectedChange.oldPath, selectedChange.newPath]
      : [filePath];
  const [status, unmerged, attributes] = await Promise.all([
    runGit(repositoryRoot, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=no",
      "--",
      ...pathspecs,
    ]),
    runGit(repositoryRoot, ["ls-files", "--unmerged", "-z", "--", ...pathspecs]),
    runGit(repositoryRoot, ["check-attr", "-z", "filter", "--", ...pathspecs]),
  ]).catch((error: unknown) =>
    failGitOperation(error, "Git could not inspect the selected file before stashing it."),
  );
  if (status.length === 0) {
    throw new Error("The selected file has no tracked changes to stash.");
  }
  if (unmerged.length > 0) {
    throw new Error("Resolve the selected file's merge conflicts before stashing it.");
  }
  if (hasActiveGitFilter(attributes)) {
    throw new Error(
      "RefHaven will not stash a file with an active Git content filter. Use an approved local workflow for this repository.",
    );
  }

  const previousStash = await resolveOptionalCommit(repositoryRoot, "refs/stash");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "refhaven-stash-index-")).catch(
    (error: unknown) =>
      failGitOperation(error, "RefHaven could not create secure temporary Git state."),
  );
  const temporaryIndex = join(temporaryDirectory, "index");
  const disabledHooksPath = join(temporaryDirectory, "hooks-disabled");
  try {
    const { indexTree, stashCommit, worktreeTree } = await createPathLimitedStashCommit(
      repositoryRoot,
      headSha,
      branchName,
      normalizedMessage,
      pathspecs,
      temporaryIndex,
      disabledHooksPath,
    ).catch((error: unknown) =>
      failGitOperation(
        error,
        "Git could not safely create the file stash. The selected file was not changed.",
      ),
    );
    const expectedOldValue = previousStash ?? "0".repeat(stashCommit.length);
    await runGit(
      repositoryRoot,
      withoutGitHooks(disabledHooksPath, [
        "update-ref",
        "--create-reflog",
        "-m",
        stashSubject,
        "refs/stash",
        stashCommit,
        expectedOldValue,
      ]),
    ).catch((error: unknown) =>
      failGitOperation(
        error,
        "Another process changed the stash list. RefHaven left the selected file untouched.",
      ),
    );

    // The index or worktree may have gained new edits while the stash commit
    // was being built. Re-snapshot both selected states and only clean them
    // when they still match the captured trees.
    const verificationIndexTree = await snapshotSelectedIndexTree(
      repositoryRoot,
      headSha,
      pathspecs,
      temporaryIndex,
      disabledHooksPath,
    ).catch((error: unknown) =>
      failGitOperation(
        error,
        `The stash was created as ${stashCommit.slice(0, 8)}, but Git could not re-verify the selected index state. The file was left untouched.`,
      ),
    );
    if (verificationIndexTree !== indexTree) {
      throw new Error(
        `The stash was created as ${stashCommit.slice(0, 8)}, but the selected index state changed while stashing. RefHaven left the newer state untouched; review both states before retrying.`,
      );
    }

    const verificationWorktreeTree = await snapshotWorktreeTree(
      repositoryRoot,
      pathspecs,
      temporaryIndex,
      disabledHooksPath,
    ).catch((error: unknown) =>
      failGitOperation(
        error,
        `The stash was created as ${stashCommit.slice(0, 8)}, but Git could not re-verify the selected file. The file was left untouched.`,
      ),
    );
    if (verificationWorktreeTree !== worktreeTree) {
      throw new Error(
        `The stash was created as ${stashCommit.slice(0, 8)}, but the selected file changed while stashing. RefHaven left the newer content untouched; review both states before retrying.`,
      );
    }
    const verificationHeadSha = await resolveRef(repositoryRoot, "HEAD").catch((error: unknown) =>
      failGitOperation(
        error,
        `The stash was created as ${stashCommit.slice(0, 8)}, but Git could not re-verify HEAD. The file was left untouched.`,
      ),
    );
    if (verificationHeadSha !== headSha) {
      throw new Error(
        `The stash was created as ${stashCommit.slice(0, 8)}, but HEAD changed while stashing. RefHaven left the newer repository state untouched; review both states before retrying.`,
      );
    }

    try {
      await restorePathsFromHead(repositoryRoot, headSha, pathspecs, disabledHooksPath);
    } catch (error) {
      throw new Error(
        `The stash was created as ${stashCommit.slice(0, 8)}, but Git could not fully clean the selected file. Refresh Source Control and inspect both states before continuing.`,
        { cause: error },
      );
    }
    return stashCommit;
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
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
  revision?: string,
): Promise<LineBlame | null> {
  assertRepositoryRelativeGitPath(filePath);
  if (revision !== undefined) {
    if (!isGitObjectId(revision)) throw new Error("The blame revision is invalid.");
    if (contents !== undefined) {
      throw new Error("Blame accepts either buffer contents or a revision, not both.");
    }
  }
  const args = [
    "blame",
    "--porcelain",
    "-L",
    `${line.toString()},${line.toString()}`,
    ...(contents === undefined ? [] : ["--contents", "-"]),
    ...(revision === undefined ? [] : [revision]),
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
  if (!isGitObjectId(baseSha)) throw new Error("The base commit SHA is invalid.");
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

export async function fileExistsAtRevision(
  repositoryRoot: string,
  sha: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  assertRepositoryRelativeGitPath(filePath);
  if (!isGitObjectId(sha)) throw new Error("The file revision SHA is invalid.");
  const output = await runGit(
    repositoryRoot,
    ["ls-tree", "-z", "--full-tree", sha, "--", filePath],
    signal,
  ).catch((error: unknown) => failGitOperation(error, "Git could not verify this file revision."));
  const separator = output.indexOf("\t");
  if (separator < 0 || !isBlobLsTreeHeader(output.slice(0, separator))) {
    return false;
  }
  return output.slice(separator + 1).replace(/\0$/u, "") === filePath;
}

export async function readCommitDiffPreview(
  repositoryRoot: string,
  fromSha: string | null,
  toSha: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  assertRepositoryRelativeGitPath(filePath);
  const args =
    fromSha === null
      ? [
          "show",
          "--format=",
          "--no-ext-diff",
          "--no-textconv",
          "--unified=2",
          toSha,
          "--",
          filePath,
        ]
      : ["diff", "--no-ext-diff", "--no-textconv", "--unified=2", fromSha, toSha, "--", filePath];
  try {
    const output = await runGit(repositoryRoot, args, signal, MAX_HOVER_DIFF_BYTES);
    return output.trim().length > 0 ? output.trimEnd() : null;
  } catch (error) {
    const normalized = normalizeGitError(error);
    if (normalized instanceof GitOperationError) {
      if (normalized.code === "commandCancelled") throw normalized;
    }
    return null;
  }
}

/**
 * Reads a shareable unified diff between two immutable revisions, a revision
 * and the working tree (`toSha === null`), or a root commit and the empty
 * tree (`fromSha === null`). Optionally limited to specific literal paths.
 */
/**
 * Reads a shareable unified diff as raw bytes so that content in a legacy or
 * mixed encoding survives verbatim and the saved patch applies cleanly. The
 * ceiling is far higher than for text output because a whole-comparison patch
 * can be large, while still bounding memory use.
 */
export async function readComparisonPatch(
  repositoryRoot: string,
  fromSha: string | null,
  toSha: string | null,
  filePaths: readonly string[] = [],
  signal?: AbortSignal,
): Promise<Buffer> {
  for (const filePath of filePaths) assertRepositoryRelativeGitPath(filePath);
  for (const sha of [fromSha, toSha]) {
    if (sha !== null && !isGitObjectId(sha)) {
      throw new Error("The patch revision is invalid.");
    }
  }
  const pathspecArgs = filePaths.length > 0 ? ["--", ...filePaths] : [];
  let args: string[];
  if (fromSha !== null) {
    args = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--patch",
      fromSha,
      ...(toSha === null ? [] : [toSha]),
      ...pathspecArgs,
    ];
  } else if (toSha !== null) {
    args = [
      "show",
      "--format=",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--patch",
      toSha,
      ...pathspecArgs,
    ];
  } else {
    throw new Error("A patch needs at least one resolved revision.");
  }
  const stdout = await runGitBuffer(repositoryRoot, args, signal, MAX_PATCH_BYTES).catch(
    (error: unknown) =>
      failGitOperation(error, "Git could not produce a patch for this selection."),
  );
  return stdout;
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

function hasActiveGitFilter(output: string): boolean {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) return true;
  for (let index = 2; index < fields.length; index += 3) {
    const value = fields[index];
    if (value !== "unspecified" && value !== "unset") return true;
  }
  return false;
}

async function createPathLimitedStashCommit(
  repositoryRoot: string,
  headSha: string,
  branchName: string,
  message: string,
  pathspecs: readonly string[],
  temporaryIndex: string,
  disabledHooksPath: string,
): Promise<{
  readonly indexTree: string;
  readonly stashCommit: string;
  readonly worktreeTree: string;
}> {
  const indexTree = await snapshotSelectedIndexTree(
    repositoryRoot,
    headSha,
    pathspecs,
    temporaryIndex,
    disabledHooksPath,
  );
  const indexCommit = parseObjectId(
    await runGitWithInput(
      repositoryRoot,
      withoutGitHooks(disabledHooksPath, ["commit-tree", indexTree, "-p", headSha]),
      `index on ${branchName}: ${headSha.slice(0, 8)} ${message}\n`,
    ),
    "Git returned an invalid stash index commit.",
  );

  const worktreeTree = await snapshotWorktreeTree(
    repositoryRoot,
    pathspecs,
    temporaryIndex,
    disabledHooksPath,
  );
  const stashCommit = parseObjectId(
    await runGitWithInput(
      repositoryRoot,
      withoutGitHooks(disabledHooksPath, [
        "commit-tree",
        worktreeTree,
        "-p",
        headSha,
        "-p",
        indexCommit,
      ]),
      `On ${branchName}: ${message}\n`,
    ),
    "Git returned an invalid stash commit.",
  );
  return { indexTree, stashCommit, worktreeTree };
}

/** Snapshots only the selected real-index entries on top of HEAD. */
async function snapshotSelectedIndexTree(
  repositoryRoot: string,
  headSha: string,
  pathspecs: readonly string[],
  temporaryIndex: string,
  disabledHooksPath: string,
): Promise<string> {
  await runGitWithTemporaryIndex(
    repositoryRoot,
    withoutGitHooks(disabledHooksPath, ["read-tree", headSha]),
    temporaryIndex,
  );
  await runGitWithTemporaryIndex(
    repositoryRoot,
    withoutGitHooks(disabledHooksPath, ["update-index", "--force-remove", "--", ...pathspecs]),
    temporaryIndex,
  );
  const selectedIndexEntries = await runGit(repositoryRoot, [
    "ls-files",
    "--stage",
    "-z",
    "--",
    ...pathspecs,
  ]);
  if (selectedIndexEntries.length > 0) {
    await runGitWithInput(
      repositoryRoot,
      withoutGitHooks(disabledHooksPath, ["update-index", "-z", "--index-info"]),
      selectedIndexEntries,
      undefined,
      temporaryIndex,
    );
  }
  const indexTree = parseObjectId(
    await runGitWithTemporaryIndex(
      repositoryRoot,
      withoutGitHooks(disabledHooksPath, ["write-tree"]),
      temporaryIndex,
    ),
    "Git returned an invalid temporary index tree.",
  );
  return indexTree;
}

/** Snapshots the selected worktree paths into the temporary index and returns their tree. */
async function snapshotWorktreeTree(
  repositoryRoot: string,
  pathspecs: readonly string[],
  temporaryIndex: string,
  disabledHooksPath: string,
): Promise<string> {
  await updateTemporaryIndexFromWorktree(
    repositoryRoot,
    pathspecs,
    temporaryIndex,
    disabledHooksPath,
  );
  return parseObjectId(
    await runGitWithTemporaryIndex(
      repositoryRoot,
      withoutGitHooks(disabledHooksPath, ["write-tree"]),
      temporaryIndex,
    ),
    "Git returned an invalid temporary worktree tree.",
  );
}

async function updateTemporaryIndexFromWorktree(
  repositoryRoot: string,
  pathspecs: readonly string[],
  temporaryIndex: string,
  disabledHooksPath: string,
): Promise<void> {
  for (const filePath of pathspecs) {
    try {
      await lstat(resolvePathWithinRepository(repositoryRoot, filePath));
      await runGitWithTemporaryIndex(
        repositoryRoot,
        withoutGitHooks(disabledHooksPath, ["add", "--", filePath]),
        temporaryIndex,
      );
    } catch (error) {
      const candidate = error as { readonly code?: unknown };
      if (candidate.code !== "ENOENT") throw error;
      await runGitWithTemporaryIndex(
        repositoryRoot,
        withoutGitHooks(disabledHooksPath, ["update-index", "--force-remove", "--", filePath]),
        temporaryIndex,
      );
    }
  }
}

async function restorePathsFromHead(
  repositoryRoot: string,
  headSha: string,
  pathspecs: readonly string[],
  disabledHooksPath: string,
): Promise<void> {
  await runGit(
    repositoryRoot,
    withoutGitHooks(disabledHooksPath, [
      "restore",
      `--source=${headSha}`,
      "--staged",
      "--worktree",
      "--",
      ...pathspecs,
    ]),
  );
}

function withoutGitHooks(hooksPath: string, args: readonly string[]): string[] {
  return ["-c", `core.hooksPath=${hooksPath}`, ...args];
}

function isSafeRemoteName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_INTERACTIVE_INPUT_LENGTH || value.startsWith("-")) {
    return false;
  }
  for (const character of value) {
    if (character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f) return false;
  }
  return true;
}

function parseObjectId(stdout: string, errorMessage: string): string {
  return requireGitObjectId(stdout.trim(), errorMessage);
}

function isBlobLsTreeHeader(value: string): boolean {
  const [mode, type, objectId, extra] = value.split(" ");
  return (
    /^\d{6}$/u.test(mode ?? "") &&
    type === "blob" &&
    objectId !== undefined &&
    isGitObjectId(objectId) &&
    extra === undefined
  );
}

async function resolveOptionalCommit(repositoryRoot: string, ref: string): Promise<string | null> {
  const stdout = await runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]).catch((error: unknown) => preserveControlErrorOrNull(error));
  return stdout === null ? null : parseObjectId(stdout, `Git returned an invalid ${ref} revision.`);
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
