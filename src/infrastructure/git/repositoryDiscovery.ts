import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

import type { RepositoryIdentity } from "../../domain/comparison";
import { pathIdentityKey } from "../../domain/pathValidation";

export interface WorkspaceFolderIdentity {
  readonly name: string;
  readonly rootPath: string;
  readonly uri: string;
}

/** Resolves discovery inputs through the filesystem before applying the workspace boundary. */
export async function buildCanonicalRepositoryIdentities(
  rootPaths: readonly string[],
  folders: readonly WorkspaceFolderIdentity[],
): Promise<RepositoryIdentity[]> {
  const [canonicalRoots, canonicalFolders] = await Promise.all([
    Promise.all(rootPaths.map(canonicalPath)),
    Promise.all(
      folders.map(async (folder) => {
        const rootPath = await canonicalPath(folder.rootPath);
        return rootPath ? { ...folder, rootPath } : null;
      }),
    ),
  ]);
  return buildRepositoryIdentities(
    canonicalRoots.filter((rootPath): rootPath is string => rootPath !== null),
    canonicalFolders.filter((folder): folder is WorkspaceFolderIdentity => folder !== null),
  );
}

export async function canonicalPath(filePath: string): Promise<string | null> {
  if (!isAbsolute(filePath)) return null;
  return realpath(filePath).catch(() => null);
}

/** Produces a stable identity for an existing path, including filesystem aliases. */
export async function canonicalPathIdentityKey(filePath: string): Promise<string | null> {
  const canonical = await canonicalPath(filePath);
  return canonical ? pathIdentityKey(canonical) : null;
}

/** Builds stable workspace-scoped identities for Git roots discovered by any adapter. */
export function buildRepositoryIdentities(
  rootPaths: readonly string[],
  folders: readonly WorkspaceFolderIdentity[],
): RepositoryIdentity[] {
  const seenRoots = new Set<string>();
  return rootPaths.flatMap((rootPath) => {
    if (!isAbsolute(rootPath)) return [];
    const key = pathIdentityKey(rootPath);
    if (seenRoots.has(key)) return [];
    const folder = findOwningWorkspaceFolder(rootPath, folders);
    if (!folder) return [];
    seenRoots.add(key);

    const relativePath = relative(folder.rootPath, rootPath);
    const relativeRepositoryPath = relativePath.length > 0 ? relativePath : ".";
    const repositoryIsAncestor = isContainedRelativePath(relative(rootPath, folder.rootPath));
    return [
      {
        label:
          relativeRepositoryPath === "."
            ? folder.name
            : repositoryIsAncestor
              ? `${basename(rootPath)} (${folder.name})`
              : `${folder.name}/${relativeRepositoryPath.split(sep).join("/")}`,
        relativeRepositoryPath,
        rootPath,
        workspaceFolderUri: folder.uri,
      },
    ];
  });
}

function findOwningWorkspaceFolder(
  repositoryRoot: string,
  folders: readonly WorkspaceFolderIdentity[],
): WorkspaceFolderIdentity | undefined {
  const repositoryKey = pathIdentityKey(repositoryRoot);
  return [...folders]
    .flatMap((folder) => {
      const folderKey = pathIdentityKey(folder.rootPath);
      const repositoryFromFolder = relative(folderKey, repositoryKey);
      const folderFromRepository = relative(repositoryKey, folderKey);
      if (
        !isContainedRelativePath(repositoryFromFolder) &&
        !isContainedRelativePath(folderFromRepository)
      ) {
        return [];
      }
      return [{ distance: pathDistance(repositoryFromFolder, folderFromRepository), folder }];
    })
    .sort(
      (left, right) =>
        left.distance - right.distance || left.folder.uri.localeCompare(right.folder.uri),
    )[0]?.folder;
}

function isContainedRelativePath(value: string): boolean {
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function pathDistance(left: string, right: string): number {
  const contained = isContainedRelativePath(left) ? left : right;
  return contained.length === 0 ? 0 : contained.split(sep).length;
}
