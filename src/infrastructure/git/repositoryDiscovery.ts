import { isAbsolute, relative, sep } from "node:path";

import type { RepositoryIdentity } from "../../domain/comparison";
import { pathIdentityKey } from "../../domain/pathValidation";

export interface WorkspaceFolderIdentity {
  readonly name: string;
  readonly rootPath: string;
  readonly uri: string;
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
    return [
      {
        label:
          relativeRepositoryPath === "."
            ? folder.name
            : `${folder.name}/${relativeRepositoryPath.replaceAll("\\", "/")}`,
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
    .filter((folder) => {
      const folderKey = pathIdentityKey(folder.rootPath);
      return (
        isContainedRelativePath(relative(folderKey, repositoryKey)) ||
        isContainedRelativePath(relative(repositoryKey, folderKey))
      );
    })
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
}

function isContainedRelativePath(value: string): boolean {
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
