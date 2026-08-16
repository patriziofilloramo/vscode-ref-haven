import type { CommitDetails } from "./commitDetails";
import type { FileChange } from "./comparisonResult";

/** Blame information for a single line of a file. */
export interface LineBlame {
  /** Author date in epoch milliseconds. */
  readonly authorDate: number;
  readonly authorEmail?: string;
  readonly authorName: string;
  /** Git's numeric timezone offset, for example `+0100`. */
  readonly authorTimeZone?: string;
  readonly finalLineNumber?: number;
  /** False when the line is not committed yet (all-zero SHA). */
  readonly isCommitted: boolean;
  readonly originalLineNumber?: number;
  /** Path of the file in the blamed commit (may differ after renames). */
  readonly path: string;
  readonly previousPath?: string;
  readonly previousSha?: string;
  readonly sha: string;
  /** Commit summary; empty for uncommitted lines. */
  readonly summary: string;
}

export interface FileBlameLine {
  /** One-based final line number in the current file. */
  readonly lineNumber: number;
  readonly blame: LineBlame;
}

/** Minimal, validated context carried by a trusted rich-hover command link. */
export interface LineBlameActionTarget {
  /** Current working-tree path and one-based line. */
  readonly filePath: string;
  readonly lineNumber: number;
  readonly repositoryRoot: string;
  /** Path and one-based line at the blamed revision, which may predate a rename. */
  readonly revisionLineNumber: number;
  readonly revisionPath: string;
  readonly sha: string;
}

export interface RichLineHover {
  readonly blame: LineBlame;
  readonly changedFileCount?: number;
  readonly commitDetails?: CommitDetails;
  readonly fileChange?: FileChange;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly parentSha?: string | null;
  readonly patchPreview?: string | null;
  readonly repositoryRoot: string;
  readonly userName: string | null;
}
