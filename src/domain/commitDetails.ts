import type { CommitInfo } from "./comparisonResult";

export interface CommitDetails {
  readonly authorEmail: string;
  readonly commit: CommitInfo;
  readonly committerDate: number;
  readonly committerEmail: string;
  readonly committerName: string;
  readonly fullMessage: string;
  readonly parentShas: readonly string[];
}

export type CommitSearchKind = "author" | "content" | "message" | "sha";
