import * as vscode from "vscode";

import type { FileChangeStatus } from "../../domain/comparisonResult";

/** URI scheme carrying a change status so tree items get SCM-style decorations. */
export const CHANGE_DECORATION_SCHEME = "branch-compare-change";

interface StatusPresentation {
  readonly badge: string;
  readonly color: string;
  readonly label: string;
}

const STATUS_PRESENTATIONS: Readonly<Record<FileChangeStatus, StatusPresentation>> = {
  added: { badge: "A", color: "gitDecoration.addedResourceForeground", label: "Added" },
  copied: { badge: "C", color: "gitDecoration.addedResourceForeground", label: "Copied" },
  deleted: { badge: "D", color: "gitDecoration.deletedResourceForeground", label: "Deleted" },
  modified: { badge: "M", color: "gitDecoration.modifiedResourceForeground", label: "Modified" },
  renamed: { badge: "R", color: "gitDecoration.renamedResourceForeground", label: "Renamed" },
  typeChanged: {
    badge: "T",
    color: "gitDecoration.modifiedResourceForeground",
    label: "Type changed",
  },
  unmerged: {
    badge: "!",
    color: "gitDecoration.conflictingResourceForeground",
    label: "Unmerged",
  },
};

export function statusLabel(status: FileChangeStatus): string {
  return STATUS_PRESENTATIONS[status].label;
}

export function createChangeUri(status: FileChangeStatus, filePath: string): vscode.Uri {
  return vscode.Uri.from({
    path: `/${filePath}`,
    query: `status=${status}`,
    scheme: CHANGE_DECORATION_SCHEME,
  });
}

export class ChangeDecorationProvider implements vscode.FileDecorationProvider {
  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CHANGE_DECORATION_SCHEME) return undefined;

    const status = /^status=([a-zA-Z]+)$/.exec(uri.query)?.[1];
    if (!status || !(status in STATUS_PRESENTATIONS)) return undefined;

    const presentation = STATUS_PRESENTATIONS[status as FileChangeStatus];
    const decoration = new vscode.FileDecoration(
      presentation.badge,
      presentation.label,
      new vscode.ThemeColor(presentation.color),
    );
    decoration.propagate = false;
    return decoration;
  }
}
