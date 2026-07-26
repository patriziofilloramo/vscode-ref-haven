import type { BranchDetails } from "../../domain/repositoryNavigation";
import { isGitObjectId } from "../../domain/gitObjectId";
import { parseGitEpochSeconds } from "./gitTimestamp";

const FIELD_SEPARATOR = "\0";

/** `git for-each-ref --format` template matching {@link parseBranchDetails}. */
export const BRANCH_DETAILS_FORMAT =
  "%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(authorname)%00%(authordate:unix)%00%(subject)%00";

/** Parses fixed-width, NUL-delimited local and remote branch metadata. */
export function parseBranchDetails(output: string): BranchDetails[] {
  const branches: BranchDetails[] = [];
  const fields = output.split(FIELD_SEPARATOR);
  for (let index = 0; index < fields.length;) {
    const fullName = fields[index++]?.replace(/^\r?\n/u, "");
    if (fullName === "" && index === fields.length) break;
    const displayName = fields[index++];
    const sha = fields[index++];
    const upstream = fields[index++];
    const track = fields[index++];
    const authorName = fields[index++];
    const epoch = fields[index++];
    const subject = fields[index++];
    if (fullName?.startsWith("refs/remotes/") && fullName.endsWith("/HEAD")) continue;
    if (
      !fullName ||
      !displayName ||
      !sha ||
      !isGitObjectId(sha) ||
      authorName === undefined ||
      epoch === undefined ||
      subject === undefined ||
      (!fullName.startsWith("refs/heads/") && !fullName.startsWith("refs/remotes/"))
    ) {
      throw new Error("Git returned malformed branch details.");
    }
    const authorSeconds = parseGitEpochSeconds(epoch);
    if (authorSeconds === null) {
      throw new Error("Git returned an invalid branch commit date.");
    }
    const tracking = parseTracking(track ?? "");
    branches.push({
      ...tracking,
      branch: {
        displayName,
        fullName,
        kind: fullName.startsWith("refs/heads/") ? "localBranch" : "remoteBranch",
      },
      latestCommit: {
        authorDate: authorSeconds * 1000,
        authorName,
        sha,
        subject,
      },
      sha,
      ...(upstream ? { upstream } : {}),
    });
  }
  return branches.sort((left, right) =>
    left.branch.displayName.localeCompare(right.branch.displayName, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function parseTracking(value: string): {
  readonly ahead: number;
  readonly behind: number;
  readonly upstreamGone: boolean;
} {
  if (value.length === 0) return { ahead: 0, behind: 0, upstreamGone: false };
  if (value === "[gone]") return { ahead: 0, behind: 0, upstreamGone: true };
  const match = /^\[(?:(?:ahead (\d+))(?:, )?)?(?:(?:behind (\d+)))?\]$/u.exec(value);
  if (!match) throw new Error("Git returned invalid branch tracking details.");
  return {
    ahead: Number.parseInt(match[1] ?? "0", 10),
    behind: Number.parseInt(match[2] ?? "0", 10),
    upstreamGone: false,
  };
}
