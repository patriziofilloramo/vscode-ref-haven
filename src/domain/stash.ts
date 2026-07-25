export interface StashEntry {
  /** Author date in epoch milliseconds. */
  readonly authorDate: number;
  /** Branch the stash was created on, when the reflog subject reveals it. */
  readonly branchName?: string;
  /** Stash message without the `WIP on branch:` reflog prefix. */
  readonly message: string;
  /** First parent of the stash commit (the commit the stash was based on). */
  readonly parentSha: string;
  /** Reflog selector such as `stash@{0}`; shifts when other stashes are dropped. */
  readonly selector: string;
  readonly sha: string;
}
