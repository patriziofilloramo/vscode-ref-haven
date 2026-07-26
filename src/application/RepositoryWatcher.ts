import * as vscode from "vscode";

import type { RepositoryIdentity } from "../domain/comparison";
import { pathIdentityKey } from "../domain/pathValidation";
import { resolveGitMetadataPaths } from "../infrastructure/git/GitCli";

/** Files inside resolved Git metadata directories that indicate repository state changes. */
const GIT_STATE_PATTERN = "{HEAD,ORIG_HEAD,index,packed-refs,refs/**,logs/HEAD,logs/refs/**}";
const NOTIFY_DEBOUNCE_MS = 1000;

/**
 * Watches each repository's .git metadata and fires a debounced callback when
 * commits, branch switches, staging, stash operations, or fetches change state.
 */
export class RepositoryWatcher implements vscode.Disposable {
  private notifyTimer: NodeJS.Timeout | undefined;
  private generation = 0;
  private watchers: vscode.FileSystemWatcher[] = [];

  public constructor(private readonly onGitStateChanged: () => void) {}

  public async setRepositories(repositories: readonly RepositoryIdentity[]): Promise<void> {
    const generation = ++this.generation;
    const metadataPaths = await Promise.all(
      repositories.map(({ rootPath }) =>
        resolveGitMetadataPaths(rootPath).catch((): string[] => []),
      ),
    );
    if (generation !== this.generation) return;

    const watchers: vscode.FileSystemWatcher[] = [];
    const uniqueMetadataPaths = new Map(
      metadataPaths.flat().map((metadataPath) => [pathIdentityKey(metadataPath), metadataPath]),
    );
    for (const metadataPath of uniqueMetadataPaths.values()) {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(metadataPath), GIT_STATE_PATTERN);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const notify = (): void => {
        this.scheduleNotification();
      };
      watcher.onDidChange(notify);
      watcher.onDidCreate(notify);
      watcher.onDidDelete(notify);
      watchers.push(watcher);
    }
    this.disposeWatchers();
    this.watchers = watchers;
  }

  public dispose(): void {
    this.generation += 1;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.disposeWatchers();
  }

  private scheduleNotification(): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      this.onGitStateChanged();
    }, NOTIFY_DEBOUNCE_MS);
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }
}
