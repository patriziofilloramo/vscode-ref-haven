import * as vscode from "vscode";

import type { FileChange } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import { COMMAND_IDS } from "../commands/commandIds";
import { formatDiffStats } from "../format";
import { escapeMarkdown } from "../markdown";
import { createChangeUri, statusLabel } from "./ChangeDecorationProvider";
import { buildFileTree, type FileTreeFolder, type FileTreeNode } from "./fileTree";

export type FilesLayout = "list" | "tree";

export interface FileNode {
  readonly file: FileChange;
  /** Prefix keeping tree item ids unique across sections and views. */
  readonly idPrefix: string;
  readonly kind: "file";
  readonly scope: FileDiffScope;
  /** Show the parent directory next to the file name (list layout). */
  readonly showDirectory: boolean;
}

export interface FolderNode {
  readonly folder: FileTreeFolder;
  readonly idPrefix: string;
  readonly kind: "folder";
  readonly scope: FileDiffScope;
}

export interface MessageNode {
  readonly icon: string;
  readonly kind: "message";
  readonly label: string;
}

export type ChangeNode = FileNode | FolderNode;

/** Renders file changes as either a flat list or a compacted folder tree. */
export function buildChangeNodes(
  files: readonly FileChange[],
  layout: FilesLayout,
  scope: FileDiffScope,
  idPrefix: string,
): ChangeNode[] {
  if (layout === "tree") return toChangeNodes(buildFileTree(files), scope, idPrefix);
  return files.map((file) => ({ file, idPrefix, kind: "file", scope, showDirectory: true }));
}

export function getFolderChildren(node: FolderNode): ChangeNode[] {
  return toChangeNodes(node.folder.children, node.scope, node.idPrefix);
}

export function createFolderItem(node: FolderNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
  item.iconPath = vscode.ThemeIcon.Folder;
  item.id = `${node.idPrefix}:folder:${node.folder.path}`;
  item.resourceUri = vscode.Uri.from({
    path: `/${node.folder.path}`,
    scheme: "branch-compare-folder",
  });
  return item;
}

export function createFileItem(node: FileNode): vscode.TreeItem {
  const { file, scope } = node;
  const fileName = file.newPath.split("/").at(-1) ?? file.newPath;
  const directory = file.newPath.split("/").slice(0, -1).join("/");

  const item = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
  item.command = {
    arguments: [scope, file],
    command: COMMAND_IDS.openFileDiff,
    title: "Open File Comparison",
  };
  item.contextValue = `branchCompare.file.${file.status}`;
  item.description = fileDescription(node, directory);
  item.iconPath = vscode.ThemeIcon.File;
  item.id = `${node.idPrefix}:file:${file.newPath}`;
  item.resourceUri = createChangeUri(file.status, file.newPath);
  item.tooltip = fileTooltip(file);
  return item;
}

export function createMessageItem(node: MessageNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(node.icon);
  return item;
}

function toChangeNodes(
  nodes: readonly FileTreeNode[],
  scope: FileDiffScope,
  idPrefix: string,
): ChangeNode[] {
  return nodes.map((node) =>
    node.kind === "folder"
      ? { folder: node, idPrefix, kind: "folder", scope }
      : { file: node.file, idPrefix, kind: "file", scope, showDirectory: false },
  );
}

function fileDescription(node: FileNode, directory: string): string {
  const { file, showDirectory } = node;
  const parts: string[] = [];
  if (showDirectory && directory.length > 0) parts.push(directory);
  if (file.status === "renamed" || file.status === "copied") {
    const from = file.oldPath ?? "";
    parts.push(from.length > 0 ? `← ${from}` : file.status);
  }
  if (file.additions !== undefined || file.deletions !== undefined) {
    parts.push(formatDiffStats(file.additions ?? 0, file.deletions ?? 0));
  } else {
    parts.push("binary");
  }
  return parts.join(" · ");
}

function fileTooltip(file: FileChange): vscode.MarkdownString {
  const lines = [
    `**${escapeMarkdown(file.newPath)}**`,
    "",
    `$(diff) ${statusLabel(file.status)}${file.similarity === undefined ? "" : ` (${file.similarity.toString()}% similar)`}`,
    ...(file.oldPath ? [`$(arrow-right) from \`${escapeMarkdown(file.oldPath)}\``] : []),
    file.additions !== undefined || file.deletions !== undefined
      ? `$(edit) ${formatDiffStats(file.additions ?? 0, file.deletions ?? 0)}`
      : "$(file-binary) binary change",
  ];
  const tooltip = new vscode.MarkdownString(lines.join("\n\n"));
  tooltip.supportThemeIcons = true;
  return tooltip;
}
