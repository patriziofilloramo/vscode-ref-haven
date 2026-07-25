import type { CommitDetails } from "../../domain/commitDetails";

export const COMMIT_DETAILS_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B%x00";

export function parseCommitDetails(stdout: string): CommitDetails {
  const [
    sha,
    parents,
    authorName,
    authorEmail,
    authorEpoch,
    committerName,
    committerEmail,
    committerEpoch,
    fullMessage,
  ] = stdout.split("\0");
  if (
    !sha ||
    parents === undefined ||
    authorName === undefined ||
    authorEmail === undefined ||
    authorEpoch === undefined ||
    committerName === undefined ||
    committerEmail === undefined ||
    committerEpoch === undefined ||
    fullMessage === undefined ||
    !/^[0-9a-f]{40,64}$/iu.test(sha)
  ) {
    throw new Error("Git returned malformed commit details.");
  }
  const authorSeconds = Number.parseInt(authorEpoch, 10);
  const committerSeconds = Number.parseInt(committerEpoch, 10);
  if (!Number.isFinite(authorSeconds) || !Number.isFinite(committerSeconds)) {
    throw new Error("Git returned invalid commit dates.");
  }
  const parentShas = parents === "" ? [] : parents.split(" ");
  if (parentShas.some((parent) => !/^[0-9a-f]{40,64}$/iu.test(parent))) {
    throw new Error("Git returned an invalid commit parent.");
  }
  const normalizedMessage = fullMessage.replace(/\r?\n$/u, "");
  return {
    authorEmail,
    commit: {
      authorDate: authorSeconds * 1000,
      authorName,
      sha,
      subject: normalizedMessage.split(/\r?\n/u)[0] ?? "",
    },
    committerDate: committerSeconds * 1000,
    committerEmail,
    committerName,
    fullMessage: normalizedMessage,
    parentShas,
  };
}
