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
export type CommitSearchPatternMode = "literal" | "regex";
export const MAX_COMMIT_SEARCH_TEXT_LENGTH = 512;

export type CommitSearchQuery =
  | {
      readonly kind: "author" | "content" | "message";
      readonly caseSensitive: boolean;
      readonly patternMode: CommitSearchPatternMode;
      readonly text: string;
    }
  | {
      readonly kind: "sha";
      readonly text: string;
    };
