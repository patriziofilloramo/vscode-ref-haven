import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { pathIdentityKey } from "../../domain/pathValidation";
import { syncDirectory, writePrivateFile } from "./stashFileTransaction";

export type RegularFileMode = "100644" | "100755";

export interface RawFingerprint {
  readonly permissions: number;
  readonly sha256: string;
  readonly size: number;
}

export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface AbsentSnapshot {
  readonly absolutePath: string;
  readonly backupPath: string;
  readonly filePath: string;
  readonly id: number;
  readonly state: "absent";
}

export interface RegularSnapshot {
  readonly absolutePath: string;
  readonly backupPath: string;
  readonly filePath: string;
  readonly fingerprint: RawFingerprint;
  readonly id: number;
  readonly identity: FileIdentity;
  readonly mode: RegularFileMode;
  readonly permissions: number;
  readonly snapshotPath: string;
  readonly state: "regular";
}

export type WorktreeSnapshot = AbsentSnapshot | RegularSnapshot;

export interface CleanFile {
  readonly fingerprint: RawFingerprint;
  readonly preparedPath: string;
}

export async function ensureRecoveryRoot(gitDirectory: string): Promise<string> {
  const recoveryRoot = join(gitDirectory, "refhaven-recovery");
  await mkdir(recoveryRoot, { mode: 0o700 }).catch((error: unknown) => {
    if (!isErrorCode(error, "EEXIST")) throw error;
  });
  const recoveryStats = await lstat(recoveryRoot);
  if (!recoveryStats.isDirectory() || recoveryStats.isSymbolicLink()) {
    throw new Error("The RefHaven recovery path is not a private local directory.");
  }
  await chmod(recoveryRoot, 0o700);
  await syncDirectory(gitDirectory);
  return recoveryRoot;
}

export function assertDistinctWorktreeTargets(snapshots: readonly WorktreeSnapshot[]): void {
  const pathKeys = new Set<string>();
  const fileIdentities = new Set<string>();
  for (const snapshot of snapshots) {
    const pathKey = pathIdentityKey(snapshot.absolutePath);
    if (pathKeys.has(pathKey)) {
      throw new Error("Single-file stash does not support a case-only rename on this filesystem.");
    }
    pathKeys.add(pathKey);
    if (snapshot.state === "absent" || snapshot.identity.inode === 0) continue;
    const identity = `${snapshot.identity.device.toString()}:${snapshot.identity.inode.toString()}`;
    if (fileIdentities.has(identity)) {
      throw new Error("Single-file stash does not support two selected paths to the same file.");
    }
    fileIdentities.add(identity);
  }
}

export async function assertSafeExistingParents(
  repositoryRoot: string,
  filePath: string,
): Promise<void> {
  const rootStats = await lstat(repositoryRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Single-file stash requires a canonical repository root.");
  }
  let current = repositoryRoot;
  for (const segment of filePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    let currentStats;
    try {
      currentStats = await lstat(current);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) {
      throw new Error("Single-file stash does not follow worktree symlinks or junctions.");
    }
  }
}

export async function ensureSafeParentDirectories(
  repositoryRoot: string,
  filePath: string,
): Promise<void> {
  let current = repositoryRoot;
  for (const segment of filePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    let created = false;
    try {
      await mkdir(current);
      created = true;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    const currentStats = await lstat(current);
    if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) {
      throw new Error("Single-file stash does not follow worktree symlinks or junctions.");
    }
    if (created) await syncDirectory(dirname(current));
  }
}

export async function assertLocalFilesystemBoundary(
  repositoryRoot: string,
  recoveryDirectory: string,
  snapshots: readonly WorktreeSnapshot[],
): Promise<void> {
  const recoveryStats = await stat(recoveryDirectory);
  for (const snapshot of snapshots) {
    await assertSafeExistingParents(repositoryRoot, snapshot.filePath);
    const parent = await findExistingParent(snapshot.absolutePath);
    if (parent.stats.dev !== recoveryStats.dev) {
      throw new Error(
        "Single-file stash requires the worktree and Git safety directory on one local filesystem.",
      );
    }
  }
}

export async function probeHardLinkSupport(
  repositoryRoot: string,
  recoveryDirectory: string,
  snapshots: readonly WorktreeSnapshot[],
): Promise<void> {
  const sourcePath = join(recoveryDirectory, `hardlink-probe-${randomUUID().replaceAll("-", "")}`);
  await writePrivateFile(sourcePath, Buffer.alloc(0), 0o600);
  try {
    const parents = new Set<string>();
    for (const snapshot of snapshots) {
      await assertSafeExistingParents(repositoryRoot, snapshot.filePath);
      parents.add((await findExistingParent(snapshot.absolutePath)).path);
    }
    for (const parent of parents) {
      const destination = join(parent, `.refhaven-link-probe-${randomUUID().replaceAll("-", "")}`);
      let linked = false;
      try {
        await link(sourcePath, destination);
        linked = true;
        await syncDirectory(parent);
      } catch (error) {
        throw new Error(
          "Single-file stash requires atomic hard-link support on the worktree filesystem.",
          { cause: error },
        );
      } finally {
        if (linked) {
          await unlink(destination);
          await syncDirectory(parent);
        }
      }
    }
  } finally {
    await unlink(sourcePath).catch((error: unknown) => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
  }
}

async function findExistingParent(absolutePath: string): Promise<{
  readonly path: string;
  readonly stats: Awaited<ReturnType<typeof stat>>;
}> {
  let candidate = dirname(absolutePath);
  for (;;) {
    try {
      const candidateStats = await lstat(candidate);
      if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
        throw new Error("Single-file stash does not follow worktree symlinks or junctions.");
      }
      return { path: candidate, stats: candidateStats };
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as { readonly code?: unknown }).code === code;
}
