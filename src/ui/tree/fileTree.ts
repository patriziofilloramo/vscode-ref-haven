import type { FileChange } from "../../domain/comparisonResult";

export interface FileTreeFolder {
  readonly children: readonly FileTreeNode[];
  readonly kind: "folder";
  /** Display name; compacted chains render as `src/application`. */
  readonly name: string;
  /** Repository-relative folder path. */
  readonly path: string;
}

export interface FileTreeLeaf {
  readonly file: FileChange;
  readonly kind: "leaf";
  readonly name: string;
}

export type FileTreeNode = FileTreeFolder | FileTreeLeaf;

interface MutableFolder {
  files: FileChange[];
  folders: Map<string, MutableFolder>;
}

/**
 * Groups changed files into a folder hierarchy. Folder chains with a single
 * child folder and no files are compacted into one node (`src/application`),
 * matching how VS Code and GitLens render sparse trees.
 */
export function buildFileTree(files: readonly FileChange[]): readonly FileTreeNode[] {
  const root: MutableFolder = { files: [], folders: new Map() };

  for (const file of files) {
    const segments = file.newPath.split("/");
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      let child = folder.folders.get(segment);
      if (!child) {
        child = { files: [], folders: new Map() };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.files.push(file);
  }

  return buildChildren(root, "");
}

function buildChildren(folder: MutableFolder, parentPath: string): FileTreeNode[] {
  const folderNodes: FileTreeFolder[] = [...folder.folders.entries()]
    .map(([name, child]) => buildFolderNode(name, child, parentPath))
    .sort((left, right) => compareNames(left.name, right.name));

  const leafNodes: FileTreeLeaf[] = folder.files
    .map((file) => ({
      file,
      kind: "leaf" as const,
      name: file.newPath.split("/").at(-1) ?? file.newPath,
    }))
    .sort((left, right) => compareNames(left.name, right.name));

  return [...folderNodes, ...leafNodes];
}

function buildFolderNode(name: string, folder: MutableFolder, parentPath: string): FileTreeFolder {
  let compactedName = name;
  let current = folder;

  while (current.files.length === 0 && current.folders.size === 1) {
    const [childName, childFolder] = [...current.folders.entries()][0] ?? [];
    if (childName === undefined || childFolder === undefined) break;
    compactedName = `${compactedName}/${childName}`;
    current = childFolder;
  }

  const path = parentPath.length > 0 ? `${parentPath}/${compactedName}` : compactedName;
  return {
    children: buildChildren(current, path),
    kind: "folder",
    name: compactedName,
    path,
  };
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
