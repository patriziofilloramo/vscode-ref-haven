import { chmod, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { pathIdentityKey } from "../../domain/pathValidation";
import {
  GitOperationError,
  normalizeGitError,
  runGit,
  runGitWithInput,
  runGitWithTemporaryIndex,
} from "./GitProcess";

const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_RECOVERY_RECORDS = 256;
const mutationTails = new Map<string, Promise<void>>();

export interface StashIndexEntry {
  readonly filePath: string;
  readonly mode: "100644" | "100755";
  readonly objectId: string;
}

export interface IndexSnapshot {
  readonly cleanPath: string;
  readonly content: Buffer;
  readonly indexPath: string;
  readonly permissions: number;
  readonly snapshotPath: string;
}

export interface HeldIndexTransaction {
  commit(cleanIndex: Buffer): Promise<void>;
  release(): Promise<void>;
}

export interface PendingStashFileRecovery {
  readonly directory: string;
}

export function cleanWorktreePermissions(
  originalPermissions: number | undefined,
  headMode: "100644" | "100755",
  fileModeEnabled: boolean,
): number {
  if (originalPermissions === undefined) return headMode === "100755" ? 0o700 : 0o600;
  if (!fileModeEnabled) return originalPermissions;
  return headMode === "100755" ? originalPermissions | 0o100 : originalPermissions & ~0o111;
}

export async function runExclusiveRepositoryMutation<T>(
  repositoryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = pathIdentityKey(repositoryRoot);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  mutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

export async function listPendingStashFileRecoveries(
  repositoryRoot: string,
): Promise<PendingStashFileRecovery[]> {
  const gitDirectory = stripTerminalLineEnding(
    await runGit(repositoryRoot, ["rev-parse", "--absolute-git-dir"]),
  );
  if (!isAbsolute(gitDirectory) || gitDirectory.includes("\0")) {
    throw new Error("Git returned an invalid metadata directory.");
  }
  await assertOrdinaryDirectory(gitDirectory, "Git metadata");
  return listPendingRecoveriesInGitDirectory(gitDirectory);
}

export async function listPendingRecoveriesInGitDirectory(
  gitDirectory: string,
): Promise<PendingStashFileRecovery[]> {
  const recoveryRoot = join(gitDirectory, "refhaven-recovery");
  const recoveryStats = await lstat(recoveryRoot).catch((error: unknown) => {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (recoveryStats === null) return [];
  if (!recoveryStats.isDirectory() || recoveryStats.isSymbolicLink()) {
    throw new Error("The RefHaven recovery path is not a private local directory.");
  }
  const entries = await readdir(recoveryRoot, { withFileTypes: true }).catch((error: unknown) => {
    throw error;
  });
  const pending: PendingStashFileRecovery[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("stash-")) continue;
    const directory = join(recoveryRoot, entry.name);
    const complete = await pathExists(join(directory, "journal-300-complete.json"));
    if (complete) continue;
    pending.push({ directory });
    if (pending.length > MAX_PENDING_RECOVERY_RECORDS) {
      throw new Error("RefHaven found too many unfinished recovery records to inspect safely.");
    }
  }
  return pending;
}

export async function assertOrdinaryDirectory(directory: string, label: string): Promise<void> {
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`${label} must be a local directory without symbolic links.`);
  }
}

export async function captureIndexSnapshot(
  gitDirectory: string,
  recoveryDirectory: string,
): Promise<IndexSnapshot> {
  const indexPath = join(gitDirectory, "index");
  const opened = await readStableIndex(indexPath);
  const snapshotPath = join(recoveryDirectory, "index-before");
  const cleanPath = join(recoveryDirectory, "index-clean");
  await writePrivateFile(snapshotPath, opened.content, 0o600);
  return {
    cleanPath,
    content: opened.content,
    indexPath,
    permissions: opened.permissions,
    snapshotPath,
  };
}

export async function prepareCleanIndex(
  repositoryRoot: string,
  pathspecs: readonly string[],
  headEntries: ReadonlyMap<string, StashIndexEntry>,
  indexSnapshot: IndexSnapshot,
  disabledHooksPath: string,
): Promise<Buffer> {
  await writePrivateFile(indexSnapshot.cleanPath, indexSnapshot.content, indexSnapshot.permissions);
  await runGitWithTemporaryIndex(
    repositoryRoot,
    withoutGitHooks(disabledHooksPath, ["update-index", "--force-remove", "--", ...pathspecs]),
    indexSnapshot.cleanPath,
  );
  if (headEntries.size > 0) {
    await runGitWithInput(
      repositoryRoot,
      withoutGitHooks(disabledHooksPath, ["update-index", "-z", "--index-info"]),
      encodeIndexEntries(headEntries.values()),
      undefined,
      { temporaryIndex: indexSnapshot.cleanPath },
    );
  }
  return (await readStableIndex(indexSnapshot.cleanPath)).content;
}

export async function publishStashRefs(
  repositoryRoot: string,
  disabledHooksPath: string,
  branchName: string,
  message: string,
  stashSha: string,
  expectedOldValue: string,
  recoveryRef: string,
): Promise<void> {
  const updates = [
    `update refs/stash ${stashSha} ${expectedOldValue}`,
    `create ${recoveryRef} ${stashSha}`,
    "",
  ].join("\n");
  await runGitWithInput(
    repositoryRoot,
    withoutGitHooks(disabledHooksPath, [
      "update-ref",
      "--stdin",
      "--create-reflog",
      "-m",
      `On ${branchName}: ${message}`,
    ]),
    updates,
  );
}

export async function deleteRecoveryRefWhenStashIsCurrent(
  repositoryRoot: string,
  disabledHooksPath: string,
  recoveryRef: string,
  stashSha: string,
): Promise<boolean> {
  const updates = [`verify refs/stash ${stashSha}`, `delete ${recoveryRef} ${stashSha}`, ""].join(
    "\n",
  );
  return runGitWithInput(
    repositoryRoot,
    withoutGitHooks(disabledHooksPath, ["update-ref", "--stdin"]),
    updates,
  ).then(
    () => true,
    (error: unknown) => {
      const normalized = normalizeGitError(error);
      if (normalized instanceof GitOperationError) throw normalized;
      return false;
    },
  );
}

export async function acquireIndexTransaction(
  snapshot: IndexSnapshot,
): Promise<HeldIndexTransaction> {
  const lockPath = `${snapshot.indexPath}.lock`;
  const handle = await open(lockPath, "wx", snapshot.permissions);
  let ownsLock = true;
  let handleOpen = true;

  const release = async (): Promise<void> => {
    if (handleOpen) {
      handleOpen = false;
      await handle.close().catch(() => undefined);
    }
    if (ownsLock) {
      ownsLock = false;
      await unlink(lockPath).catch((error: unknown) => {
        if (!isErrorCode(error, "ENOENT")) throw error;
      });
    }
  };

  try {
    await chmod(lockPath, snapshot.permissions);
    const current = await readStableIndex(snapshot.indexPath);
    if (!snapshot.content.equals(current.content)) {
      throw new Error("The Git index changed before its lock could be acquired.");
    }
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }

  return {
    async commit(cleanIndex: Buffer): Promise<void> {
      if (!ownsLock || !handleOpen) throw new Error("The Git index lock is no longer owned.");
      const current = await readStableIndex(snapshot.indexPath);
      if (!snapshot.content.equals(current.content)) {
        throw new Error("The Git index changed while its lock was held.");
      }
      await handle.writeFile(cleanIndex);
      await handle.sync();
      handleOpen = false;
      await handle.close();
      await rename(lockPath, snapshot.indexPath);
      ownsLock = false;
      await syncDirectory(dirname(snapshot.indexPath));
    },
    release,
  };
}

export async function readIndexContent(indexPath: string): Promise<Buffer> {
  return (await readStableIndex(indexPath)).content;
}

export function stripTerminalLineEnding(output: string): string {
  if (output.endsWith("\r\n")) return output.slice(0, -2);
  if (output.endsWith("\n")) return output.slice(0, -1);
  return output;
}

async function readStableIndex(
  indexPath: string,
): Promise<{ readonly content: Buffer; readonly permissions: number }> {
  const pathStats = await lstat(indexPath).catch((error: unknown) => {
    if (isErrorCode(error, "ENOENT")) {
      throw new Error("The Git index disappeared during the stash transaction.", {
        cause: error,
      });
    }
    throw error;
  });
  if (!pathStats.isFile()) throw new Error("The repository does not have a regular Git index.");
  if (pathStats.size > MAX_INDEX_BYTES)
    throw new Error("The Git index is too large to stash safely.");

  const handle = await open(indexPath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(pathStats, before)) {
      throw new Error("The Git index changed while it was being opened.");
    }
    if (before.size > MAX_INDEX_BYTES)
      throw new Error("The Git index is too large to stash safely.");
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, content.byteLength);
    const after = await handle.stat();
    if (
      !sameStableFile(before, after) ||
      offset !== content.byteLength ||
      overflowBytes !== 0 ||
      after.size !== content.byteLength
    ) {
      throw new Error("The Git index changed while it was being captured.");
    }
    return { content, permissions: after.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export async function writePrivateFile(
  filePath: string,
  content: Buffer | string,
  mode: number,
): Promise<void> {
  const handle = await open(filePath, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, mode);
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

export function encodeIndexEntries(entries: Iterable<StashIndexEntry>): string {
  return [...entries]
    .map(({ filePath, mode, objectId }) => `${mode} ${objectId}\t${filePath}\0`)
    .join("");
}

function withoutGitHooks(hooksPath: string, args: readonly string[]): string[] {
  return ["-c", `core.hooksPath=${hooksPath}`, ...args];
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && (left.ino === 0 || right.ino === 0 || left.ino === right.ino);
}

function sameStableFile(
  left: { ctimeMs: number; dev: number; ino: number; mtimeMs: number; size: number },
  right: { ctimeMs: number; dev: number; ino: number; mtimeMs: number; size: number },
): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as { readonly code?: unknown }).code === code;
}
