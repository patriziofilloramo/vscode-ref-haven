import * as vscode from "vscode";

import type { FileChange } from "../../domain/comparisonResult";
import type { FileDiffScope } from "../../domain/fileDiffScope";
import { resolvePathWithinRepository } from "../../domain/pathValidation";
import type { GitRevisionContentProvider } from "./GitRevisionContentProvider";

export function createFileDiffUris(
  revisionProvider: GitRevisionContentProvider,
  scope: FileDiffScope,
  file: FileChange,
): { readonly left: vscode.Uri; readonly right: vscode.Uri } {
  const repositoryRoot = scope.repositoryRootPath;
  const oldPath = file.oldPath ?? file.newPath;
  const left =
    file.status === "added" || scope.fromSha === null
      ? revisionProvider.createEmptyUri(file.newPath)
      : revisionProvider.createRevisionUri(repositoryRoot, scope.fromSha, oldPath);
  const right =
    file.status === "deleted"
      ? revisionProvider.createEmptyUri(file.newPath)
      : scope.toSha === null
        ? vscode.Uri.file(resolvePathWithinRepository(repositoryRoot, file.newPath))
        : revisionProvider.createRevisionUri(repositoryRoot, scope.toSha, file.newPath);
  return { left, right };
}
