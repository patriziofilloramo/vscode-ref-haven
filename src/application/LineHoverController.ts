import type * as vscode from "vscode";

import type { RichLineHover } from "../domain/blame";
import type { FileChange } from "../domain/comparisonResult";
import {
  blameLine,
  listCommitFileChanges,
  readCommitDetails,
  readCommitDiffPreview,
  readGitUserName,
} from "../infrastructure/git/GitCli";
import { resolveFileContextTarget, resolveKnownFileTarget } from "../ui/commands/fileContext";
import type { FileContextTarget } from "../ui/commands/fileContext";
import type {
  GitRevisionContentProvider,
  RevisionDocumentIdentity,
} from "../ui/documents/GitRevisionContentProvider";
import type { Logger } from "./Logger";

const MAX_CACHE_ENTRIES = 64;

export class LineHoverController {
  private readonly cache = new Map<string, RichLineHover>();
  private readonly targets = new Map<string, Promise<FileContextTarget | null>>();
  private readonly userNames = new Map<string, Promise<string | null>>();

  public constructor(
    private readonly revisionProvider: GitRevisionContentProvider,
    private readonly logger: Logger,
  ) {}

  public refresh(): void {
    this.cache.clear();
    this.targets.clear();
    this.userNames.clear();
  }

  public async load(
    document: vscode.TextDocument,
    zeroBasedLine: number,
    signal: AbortSignal,
  ): Promise<RichLineHover | null> {
    if (zeroBasedLine < 0 || zeroBasedLine >= document.lineCount) return null;
    // Signed revision documents blame at their pinned revision, which lets a
    // hover chain walk backwards through history (time-travel blame).
    const revision = this.revisionProvider.parseVerifiedRevisionUri(document.uri);
    const target = revision
      ? await this.getRevisionTarget(document.uri, revision)
      : await this.getTarget(document.uri);
    if (!target || signal.aborted) return null;

    const key = [
      document.uri.toString(),
      document.version.toString(),
      zeroBasedLine.toString(),
    ].join(":");
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const blame = await blameLine(
      target.repositoryRoot,
      target.filePath,
      zeroBasedLine + 1,
      revision || !document.isDirty ? undefined : document.getText(),
      signal,
      revision?.sha,
    );
    if (!blame) return null;

    const userName = await this.getUserName(target.repositoryRoot);
    let result: RichLineHover = {
      blame,
      filePath: target.filePath,
      lineNumber: zeroBasedLine + 1,
      repositoryRoot: target.repositoryRoot,
      userName,
    };

    if (blame.isCommitted) {
      const [details, changed] = await Promise.all([
        readCommitDetails(target.repositoryRoot, blame.sha, signal),
        listCommitFileChanges(target.repositoryRoot, blame.sha, signal),
      ]);
      const fileChange =
        findFileChange(changed.files, blame.path, target.filePath) ??
        defaultFileChange(blame.path, changed.parentSha);
      const patchPreview = await readCommitDiffPreview(
        target.repositoryRoot,
        changed.parentSha,
        blame.sha,
        fileChange.newPath,
        signal,
      );
      result = {
        ...result,
        changedFileCount: changed.files.length,
        commitDetails: details,
        fileChange,
        parentSha: changed.parentSha,
        patchPreview,
      };
    }

    this.cache.set(key, result);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.logger.info("Loaded rich line hover", { operation: "lineHover" });
    return result;
  }

  private getTarget(uri: vscode.Uri): Promise<FileContextTarget | null> {
    const key = uri.toString();
    let pending = this.targets.get(key);
    if (!pending) {
      pending = resolveFileContextTarget(uri);
      this.targets.set(key, pending);
      void pending.catch(() => this.targets.delete(key));
    }
    return pending;
  }

  private getRevisionTarget(
    uri: vscode.Uri,
    revision: RevisionDocumentIdentity,
  ): Promise<FileContextTarget | null> {
    const key = uri.toString();
    let pending = this.targets.get(key);
    if (!pending) {
      pending = resolveKnownFileTarget(revision.repositoryRoot, revision.filePath);
      this.targets.set(key, pending);
      void pending.catch(() => this.targets.delete(key));
    }
    return pending;
  }

  private getUserName(repositoryRoot: string): Promise<string | null> {
    let pending = this.userNames.get(repositoryRoot);
    if (!pending) {
      pending = readGitUserName(repositoryRoot);
      this.userNames.set(repositoryRoot, pending);
      void pending.catch(() => this.userNames.delete(repositoryRoot));
    }
    return pending;
  }
}

function findFileChange(
  files: readonly FileChange[],
  blamedPath: string,
  currentPath: string,
): FileChange | undefined {
  return files.find(
    ({ newPath, oldPath }) =>
      newPath === blamedPath ||
      newPath === currentPath ||
      oldPath === blamedPath ||
      oldPath === currentPath,
  );
}

function defaultFileChange(filePath: string, parentSha: string | null): FileChange {
  return { newPath: filePath, status: parentSha === null ? "added" : "modified" };
}
