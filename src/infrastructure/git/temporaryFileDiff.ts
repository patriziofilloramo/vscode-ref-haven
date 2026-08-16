import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGitWithExitCode } from "./GitProcess";

const MAX_BUFFER_DIFF_BYTES = 5 * 1_024 * 1_024;

/**
 * Diffs immutable Git bytes against unsaved editor text without touching the
 * worktree. The private temporary directory is always removed before return;
 * `--no-index`, `--no-ext-diff`, and `--no-textconv` prevent repository
 * attributes from executing helpers against either file.
 */
export async function readTemporaryBufferDiff(
  repositoryRoot: string,
  baseContents: Buffer,
  currentContents: string,
  signal?: AbortSignal,
): Promise<string> {
  if (
    baseContents.byteLength > MAX_BUFFER_DIFF_BYTES ||
    Buffer.byteLength(currentContents, "utf8") > MAX_BUFFER_DIFF_BYTES
  ) {
    throw new Error("The editor buffer is too large to annotate safely.");
  }

  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "refhaven-file-annotations-"));
  const basePath = join(directory, "base");
  const currentPath = join(directory, "current");
  try {
    await writeFile(basePath, baseContents, { flag: "wx", mode: 0o600, signal });
    await writeFile(currentPath, currentContents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      signal,
    });
    signal?.throwIfAborted();
    const { stdout } = await runGitWithExitCode(
      repositoryRoot,
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--text",
        "--unified=0",
        "--",
        basePath,
        currentPath,
      ],
      [1],
      signal,
    );
    return stdout;
  } finally {
    await rm(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 });
  }
}
