/** Blame information for a single line of a file. */
export interface LineBlame {
  /** Author date in epoch milliseconds. */
  readonly authorDate: number;
  readonly authorName: string;
  /** False when the line is not committed yet (all-zero SHA). */
  readonly isCommitted: boolean;
  /** Path of the file in the blamed commit (may differ after renames). */
  readonly path: string;
  readonly sha: string;
  /** Commit summary; empty for uncommitted lines. */
  readonly summary: string;
}
