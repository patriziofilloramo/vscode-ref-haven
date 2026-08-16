import { isAbsolute } from "node:path";

import * as vscode from "vscode";

import type { FileChange } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import {
  assertRepositoryRelativeGitPath,
  pathIdentityKey,
  resolvePathWithinRepository,
} from "../../domain/pathValidation";
import { isFileChange, isFileDiffScope } from "../../domain/validation";
import {
  canonicalPathIdentityKey,
  discoverRepositories,
  resolveWorkspaceRepositoryFile,
} from "../../infrastructure/git/GitCli";
import type { FileNode } from "../tree/changeNodes";

export interface KnownGitTarget {
  readonly filePath: string;
  readonly repositoryRoot: string;
}

export interface FileContextTarget extends KnownGitTarget {
  readonly uri: vscode.Uri;
}

export async function resolveFileContextTarget(
  candidate?: unknown,
): Promise<FileContextTarget | null> {
  const fileNode = asFileNode(candidate);
  if (fileNode) {
    return resolveKnownFileTarget(fileNode.scope.repositoryRootPath, fileNode.file.newPath);
  }

  const uri =
    candidate instanceof vscode.Uri
      ? candidate
      : (resourceUri(candidate) ??
        (candidate === undefined ? vscode.window.activeTextEditor?.document.uri : undefined));
  if (uri?.scheme !== "file") return null;

  const target = await resolveWorkspaceRepositoryFile(uri.fsPath);
  return target ? { ...target, uri } : null;
}

/** Resolves a trusted repository/path pair without materializing a filesystem URI. */
export async function resolveKnownGitTarget(
  repositoryRoot: unknown,
  filePath: unknown,
): Promise<KnownGitTarget | null> {
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) return null;
  try {
    assertRepositoryRelativeGitPath(filePath);
  } catch {
    return null;
  }
  const [expectedRoot, repositories] = await Promise.all([
    canonicalPathIdentityKey(repositoryRoot),
    discoverRepositories(),
  ]);
  if (!expectedRoot) return null;
  const repository = repositories.find(
    ({ rootPath }) => pathIdentityKey(rootPath) === expectedRoot,
  );
  return repository ? { filePath, repositoryRoot: repository.rootPath } : null;
}

export async function resolveKnownFileTarget(
  repositoryRoot: unknown,
  filePath: unknown,
): Promise<FileContextTarget | null> {
  const target = await resolveKnownGitTarget(repositoryRoot, filePath);
  if (!target) return null;
  try {
    return {
      ...target,
      uri: vscode.Uri.file(resolvePathWithinRepository(target.repositoryRoot, target.filePath)),
    };
  } catch {
    return null;
  }
}

export async function activateFileContextTarget(target: FileContextTarget): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(target.uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) return false;
  } catch {
    return false;
  }
  await vscode.window.showTextDocument(target.uri, { preserveFocus: false, preview: true });
  return true;
}

export function asFileNode(candidate: unknown): FileNode | null {
  const node = candidate as
    | {
        readonly file?: FileChange;
        readonly kind?: unknown;
        readonly scope?: FileDiffScope;
      }
    | undefined;
  return node?.kind === "file" && isFileChange(node.file) && isFileDiffScope(node.scope)
    ? (candidate as FileNode)
    : null;
}

function resourceUri(candidate: unknown): vscode.Uri | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const resource = candidate as { readonly resourceUri?: unknown; readonly uri?: unknown };
  if (resource.resourceUri instanceof vscode.Uri) return resource.resourceUri;
  return resource.uri instanceof vscode.Uri ? resource.uri : undefined;
}
