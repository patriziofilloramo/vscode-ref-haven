/**
 * Identifies the two revisions a set of file changes was computed between.
 * Comparisons, single commits, and stashes all open diffs through this shape.
 */
export interface FileDiffScope {
  /** Left-side revision; null renders an empty document (root commits). */
  readonly fromSha: string | null;
  /** Suffix appended to diff editor titles, e.g. `feature relative to main`. */
  readonly label: string;
  readonly repositoryRootPath: string;
  readonly toSha: string;
}
