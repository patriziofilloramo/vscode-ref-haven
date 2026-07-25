import type { BranchDetails } from "../../domain/repositoryNavigation";
import { isGitObjectId } from "../../domain/gitObjectId";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\0";

export const BRANCH_DETAILS_FORMAT =
  "%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(authorname)%00%(authordate:unix)%00%(subject)%1e";

export function parseBranchDetails(output: string): BranchDetails[] {
  const branches: BranchDetails[] = [];
  for (const record of output.split(RECORD_SEPARATOR)) {
    const normalized = record.replace(/^\r?\n/u, "");
    if (normalized.length === 0) continue;
    const [fullName, displayName, sha, upstream, track, authorName, epoch, subject] =
      normalized.split(FIELD_SEPARATOR);
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
    const authorSeconds = Number.parseInt(epoch, 10);
    if (!Number.isSafeInteger(authorSeconds) || authorSeconds < 0) {
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
