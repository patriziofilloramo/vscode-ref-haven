import { dirname, isAbsolute, relative, sep } from "node:path";

import * as vscode from "vscode";

import type { FileChange } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import { pathIdentityKey, resolvePathWithinRepository } from "../../domain/pathValidation";
import { isFileChange, isFileDiffScope } from "../../domain/validation";
import { discoverRepositories, findRepositoryRoot } from "../../infrastructure/git/GitCli";
import type { FileNode } from "../tree/changeNodes";

export interface FileContextTarget {
  readonly filePath: string;
  readonly repositoryRoot: string;
  readonly uri: vscode.Uri;
}

export async function resolveFileContextTarget(
  candidate?: unknown,
): Promise<FileContextTarget | null> {
  const fileNode = asFileNode(candidate);
  if (fileNode) {
    return canonicalizeTarget({
      filePath: fileNode.file.newPath,
      repositoryRoot: fileNode.scope.repositoryRootPath,
      uri: vscode.Uri.file(
        resolvePathWithinRepository(fileNode.scope.repositoryRootPath, fileNode.file.newPath),
      ),
    });
  }

  const uri =
    candidate instanceof vscode.Uri
      ? candidate
      : (resourceUri(candidate) ??
        (candidate === undefined ? vscode.window.activeTextEditor?.document.uri : undefined));
  if (uri?.scheme !== "file") return null;

  const repositoryRoot = await findRepositoryRoot(dirname(uri.fsPath));
  if (!repositoryRoot) return null;
  const nativePath = relative(repositoryRoot, uri.fsPath);
  if (
    nativePath.length === 0 ||
    nativePath === ".." ||
    nativePath.startsWith(`..${sep}`) ||
    isAbsolute(nativePath)
  ) {
    return null;
  }

  return canonicalizeTarget({
    filePath: nativePath.replaceAll("\\", "/"),
    repositoryRoot,
    uri,
  });
}

export async function resolveKnownFileTarget(
  repositoryRoot: unknown,
  filePath: unknown,
): Promise<FileContextTarget | null> {
  if (typeof repositoryRoot !== "string" || typeof filePath !== "string" || filePath.length === 0) {
    return null;
  }
  try {
    return await canonicalizeTarget({
      filePath,
      repositoryRoot,
      uri: vscode.Uri.file(resolvePathWithinRepository(repositoryRoot, filePath)),
    });
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

async function canonicalizeTarget(target: FileContextTarget): Promise<FileContextTarget | null> {
  const expectedRoot = pathIdentityKey(target.repositoryRoot);
  const repository = (await discoverRepositories()).find(
    ({ rootPath }) => pathIdentityKey(rootPath) === expectedRoot,
  );
  if (!repository) return null;
  return {
    filePath: target.filePath,
    repositoryRoot: repository.rootPath,
    uri: vscode.Uri.file(resolvePathWithinRepository(repository.rootPath, target.filePath)),
  };
}

function resourceUri(candidate: unknown): vscode.Uri | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const resource = candidate as { readonly resourceUri?: unknown; readonly uri?: unknown };
  if (resource.resourceUri instanceof vscode.Uri) return resource.resourceUri;
  return resource.uri instanceof vscode.Uri ? resource.uri : undefined;
}
