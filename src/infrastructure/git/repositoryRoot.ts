import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import * as vscode from "vscode";

import { assertRepositoryWorktreeGitPath } from "../../domain/pathValidation";
import { runGit } from "./GitProcess";
import { buildCanonicalRepositoryIdentities, canonicalPath } from "./repositoryDiscovery";

export interface WorkspaceRepositoryFile {
  readonly filePath: string;
  readonly repositoryRoot: string;
}

/** Resolves a workspace file against its canonical containing repository. */
export async function resolveWorkspaceRepositoryFile(
  filePath: string,
): Promise<WorkspaceRepositoryFile | null> {
  if (!isAbsolute(filePath)) return null;
  const workingDirectory = await nearestExistingWorkspaceDirectory(dirname(filePath));
  if (!workingDirectory) return null;

  const stdout = await runGit(workingDirectory, ["rev-parse", "--show-toplevel"]).catch(() => null);
  const rootPath = stdout?.trim();
  if (!rootPath || rootPath.length === 0) return null;

  const [repository, canonicalWorkingDirectory] = await Promise.all([
    buildCanonicalRepositoryIdentities(
      [rootPath],
      (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        name: folder.name,
        rootPath: folder.uri.fsPath,
        uri: folder.uri.toString(),
      })),
    ).then((repositories) => repositories[0]),
    canonicalPath(workingDirectory),
  ]);
  if (!repository || !canonicalWorkingDirectory) return null;

  const suffix = relative(workingDirectory, filePath);
  if (!isPathAtOrBelow(".", suffix)) return null;
  const canonicalFilePath = resolve(canonicalWorkingDirectory, suffix);
  const nativeRelativePath = relative(repository.rootPath, canonicalFilePath);
  if (!isPathAtOrBelow(".", nativeRelativePath) || nativeRelativePath.length === 0) return null;

  const gitPath = nativeRelativePath.split(sep).join("/");
  try {
    assertRepositoryWorktreeGitPath(gitPath);
  } catch {
    return null;
  }
  return { filePath: gitPath, repositoryRoot: repository.rootPath };
}

async function nearestExistingWorkspaceDirectory(directory: string): Promise<string | null> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(directory));
  if (workspaceFolder?.uri.scheme !== "file") return null;

  const boundary = workspaceFolder.uri.fsPath;
  let candidate = directory;
  while (isPathAtOrBelow(boundary, candidate)) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
      if ((stat.type & vscode.FileType.Directory) !== 0) return candidate;
    } catch {
      // Deleted SCM resources can have several missing parent directories.
    }

    if (relative(boundary, candidate).length === 0) return null;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return null;
}

function isPathAtOrBelow(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return (
    child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}
