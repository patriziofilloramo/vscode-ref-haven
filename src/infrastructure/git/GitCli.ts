import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";

import * as vscode from "vscode";

import type { LineBlame } from "../../domain/blame";
import type { BranchRef, RepositoryIdentity } from "../../domain/comparison";
import type { CommitInfo, FileChange } from "../../domain/comparisonResult";
import type { StashEntry } from "../../domain/stash";
import { parseBlamePorcelain } from "./blamePorcelain";
import { parseBranchRefs } from "./branchRefs";
import { COMMIT_LOG_FORMAT, parseCommitLog } from "./commitLog";
import { parseNameStatusZ } from "./nameStatus";
import { mergeChangesWithStats, parseNumstatZ } from "./numstat";
import { STASH_LOG_FORMAT, parseStashList } from "./stashList";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 5 * 1024 * 1024;

export async function discoverRepositories(): Promise<RepositoryIdentity[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const seenRoots = new Set<string>();
  const repositories: RepositoryIdentity[] = [];

  for (const folder of folders) {
    const rootPath = await runGit(folder.uri.fsPath, ["rev-parse", "--show-toplevel"]).catch(
      () => null,
    );
    if (!rootPath) continue;

    const normalizedRoot = rootPath.trim();
    const identityKey = normalizedRoot.toLocaleLowerCase();
    if (seenRoots.has(identityKey)) continue;
    seenRoots.add(identityKey);

    const relativePath = relative(folder.uri.fsPath, normalizedRoot);
    const relativeRepositoryPath = relativePath.length > 0 ? relativePath : ".";
    repositories.push({
      label:
        relativeRepositoryPath === "."
          ? folder.name
          : `${folder.name}/${relativeRepositoryPath.replaceAll("\\", "/")}`,
      relativeRepositoryPath,
      rootPath: normalizedRoot,
      workspaceFolderUri: folder.uri.toString(),
    });
  }

  return repositories;
}

export async function listBranchRefs(repositoryRoot: string): Promise<BranchRef[]> {
  const stdout = await runGit(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname)%09%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  return parseBranchRefs(stdout);
}

export async function readCurrentBranch(repositoryRoot: string): Promise<string | null> {
  const stdout = await runGit(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
    () => null,
  );
  const branchName = stdout?.trim();
  return branchName && branchName.length > 0 ? branchName : null;
}

export async function resolveRef(repositoryRoot: string, fullName: string): Promise<string> {
  const stdout = await runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${fullName}^{commit}`,
  ]).catch(() => {
    throw new Error("A selected branch no longer exists or cannot be resolved.");
  });
  return parseObjectId(stdout, `Could not resolve ${fullName}.`);
}

export async function findMergeBase(
  repositoryRoot: string,
  baseSha: string,
  targetSha: string,
): Promise<string | null> {
  const stdout = await runGit(repositoryRoot, ["merge-base", baseSha, targetSha]).catch(() => null);
  return stdout === null ? null : parseObjectId(stdout, "Git returned an invalid merge base.");
}

export async function listChangedFiles(
  repositoryRoot: string,
  fromSha: string,
  toSha: string,
): Promise<FileChange[]> {
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGit(repositoryRoot, ["diff", "--name-status", "-z", "--find-renames", fromSha, toSha, "--"]),
    runGit(repositoryRoot, ["diff", "--numstat", "-z", "--find-renames", fromSha, toSha, "--"]),
  ]).catch(() => {
    throw new Error("Git could not calculate the changed files for this comparison.");
  });
  return mergeChangesWithStats(parseNameStatusZ(nameStatusOutput), parseNumstatZ(numstatOutput));
}

export async function countAheadBehind(
  repositoryRoot: string,
  baseSha: string,
  targetSha: string,
): Promise<{ readonly ahead: number; readonly behind: number }> {
  const stdout = await runGit(repositoryRoot, [
    "rev-list",
    "--left-right",
    "--count",
    `${baseSha}...${targetSha}`,
  ]).catch(() => {
    throw new Error("Git could not count the commits between these branches.");
  });
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
): Promise<CommitInfo[]> {
  const stdout = await runGit(repositoryRoot, [
    "log",
    `--max-count=${limit.toString()}`,
    `--format=${COMMIT_LOG_FORMAT}`,
    `${fromSha}..${toSha}`,
    "--",
  ]).catch(() => {
    throw new Error("Git could not list the commits between these branches.");
  });
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
): Promise<CommitFileChanges> {
  const parentOutput = await runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${sha}^`,
  ]).catch(() => null);
  if (parentOutput !== null) {
    const parentSha = parseObjectId(parentOutput, "Git returned an invalid parent commit.");
    return { files: await listChangedFiles(repositoryRoot, parentSha, sha), parentSha };
  }

  const diffTreeArgs = ["diff-tree", "--no-commit-id", "-r", "-z", "--root", "--find-renames"];
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGit(repositoryRoot, [...diffTreeArgs, "--name-status", sha, "--"]),
    runGit(repositoryRoot, [...diffTreeArgs, "--numstat", sha, "--"]),
  ]).catch(() => {
    throw new Error("Git could not calculate the changed files for this commit.");
  });
  return {
    files: mergeChangesWithStats(parseNameStatusZ(nameStatusOutput), parseNumstatZ(numstatOutput)),
    parentSha: null,
  };
}

export async function listStashes(repositoryRoot: string): Promise<StashEntry[]> {
  const stdout = await runGit(repositoryRoot, [
    "stash",
    "list",
    `--format=${STASH_LOG_FORMAT}`,
  ]).catch(() => {
    throw new Error("Git could not list the stashes for this repository.");
  });
  return parseStashList(stdout);
}

export async function applyStash(repositoryRoot: string, selector: string): Promise<void> {
  await runStashCommand(repositoryRoot, ["stash", "apply", validateStashSelector(selector)]);
}

export async function popStash(repositoryRoot: string, selector: string): Promise<void> {
  await runStashCommand(repositoryRoot, ["stash", "pop", validateStashSelector(selector)]);
}

export async function dropStash(repositoryRoot: string, selector: string): Promise<void> {
  await runStashCommand(repositoryRoot, ["stash", "drop", validateStashSelector(selector)]);
}

/** Stashes working tree changes; returns Git's status line for display. */
export async function pushStash(
  repositoryRoot: string,
  message: string | null,
  includeUntracked: boolean,
): Promise<string> {
  const args = ["stash", "push"];
  if (includeUntracked) args.push("--include-untracked");
  if (message !== null && message.length > 0) args.push("--message", message);
  const stdout = await runStashCommand(repositoryRoot, args);
  return stdout.trim().split("\n")[0]?.trim() ?? "";
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
  const stdout = await runGitWithInput(repositoryRoot, args, contents).catch(() => null);
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
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${sha}:${filePath}`], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return stdout;
  } catch {
    throw new Error("Git could not read this file revision.");
  }
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  return stdout;
}

/** Like {@link runGit}, but optionally feeds `input` to Git's stdin. */
function runGitWithInput(
  cwd: string,
  args: readonly string[],
  input: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, maxBuffer: MAX_GIT_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error instanceof Error ? error : new Error("Git invocation failed."));
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
}

/** Runs a mutating stash command, surfacing Git's stderr (e.g. conflicts). */
async function runStashCommand(cwd: string, args: readonly string[]): Promise<string> {
  try {
    return await runGit(cwd, args);
  } catch (error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    throw new Error(detail.length > 0 ? detail : "The Git stash operation failed.", {
      cause: error,
    });
  }
}

function validateStashSelector(selector: string): string {
  if (!/^stash@\{\d+\}$/.test(selector)) throw new Error("The stash reference is invalid.");
  return selector;
}

function parseObjectId(stdout: string, errorMessage: string): string {
  const objectId = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(objectId)) throw new Error(errorMessage);
  return objectId;
}
