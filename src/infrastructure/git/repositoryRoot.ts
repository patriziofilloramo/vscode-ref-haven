import { dirname, isAbsolute, relative, sep } from "node:path";

import * as vscode from "vscode";

import { runGit } from "./GitProcess";
import { buildRepositoryIdentities } from "./repositoryDiscovery";

/** Resolves a repository root inside the trusted workspace, or returns null. */
export async function findRepositoryRoot(directory: string): Promise<string | null> {
  const workingDirectory = await nearestExistingWorkspaceDirectory(directory);
  if (!workingDirectory) return null;

  const stdout = await runGit(workingDirectory, ["rev-parse", "--show-toplevel"]).catch(() => null);
  const rootPath = stdout?.trim();
  if (!rootPath || rootPath.length === 0) return null;

  const repository = buildRepositoryIdentities(
    [rootPath],
    (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      rootPath: folder.uri.fsPath,
      uri: folder.uri.toString(),
    })),
  )[0];
  return repository?.rootPath ?? null;
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
