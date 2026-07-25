import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";

import * as vscode from "vscode";

import type { BranchRef, RepositoryIdentity } from "../../domain/comparison";
import type { FileChange } from "../../domain/comparisonResult";
import { parseBranchRefs } from "./branchRefs";
import { parseNameStatusZ } from "./nameStatus";

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
  const stdout = await runGit(repositoryRoot, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    fromSha,
    toSha,
    "--",
  ]).catch(() => {
    throw new Error("Git could not calculate the changed files for this comparison.");
  });
  return parseNameStatusZ(stdout);
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

function parseObjectId(stdout: string, errorMessage: string): string {
  const objectId = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(objectId)) throw new Error(errorMessage);
  return objectId;
}
