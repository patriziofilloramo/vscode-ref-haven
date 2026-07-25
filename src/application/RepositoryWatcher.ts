import * as vscode from "vscode";

import type { RepositoryIdentity } from "../domain/comparison";

/** Files inside .git whose changes indicate the repository state moved. */
const GIT_STATE_PATTERN = ".git/{HEAD,ORIG_HEAD,packed-refs,refs/**,logs/HEAD}";
const NOTIFY_DEBOUNCE_MS = 1000;

/**
 * Watches each repository's .git metadata and fires a debounced callback when
 * commits, branch switches, stash operations, or fetches change the state.
 */
export class RepositoryWatcher implements vscode.Disposable {
  private notifyTimer: NodeJS.Timeout | undefined;
  private watchers: vscode.FileSystemWatcher[] = [];

  public constructor(private readonly onGitStateChanged: () => void) {}

  public setRepositories(repositories: readonly RepositoryIdentity[]): void {
    this.disposeWatchers();
    for (const repository of repositories) {
      const pattern = new vscode.RelativePattern(
        vscode.Uri.file(repository.rootPath),
        GIT_STATE_PATTERN,
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const notify = (): void => {
        this.scheduleNotification();
      };
      watcher.onDidChange(notify);
      watcher.onDidCreate(notify);
      watcher.onDidDelete(notify);
      this.watchers.push(watcher);
    }
  }

  public dispose(): void {
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
