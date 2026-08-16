import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdtemp, open, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { isGitObjectId, requireGitObjectId } from "../../domain/gitObjectId";
import { resolvePathWithinRepository } from "../../domain/pathValidation";
import {
  GitOperationError,
  normalizeGitError,
  runGit,
  runGitBuffer,
  runGitWithInput,
  runGitWithTemporaryIndex,
} from "./GitProcess";
import {
  acquireIndexTransaction,
  assertOrdinaryDirectory,
  captureIndexSnapshot,
  cleanWorktreePermissions,
  deleteRecoveryRefWhenStashIsCurrent,
  encodeIndexEntries,
  type HeldIndexTransaction,
  type IndexSnapshot,
  listPendingRecoveriesInGitDirectory,
  prepareCleanIndex,
  publishStashRefs,
  readIndexContent,
  runExclusiveRepositoryMutation,
  type StashIndexEntry,
  stripTerminalLineEnding,
  syncDirectory,
  writePrivateFile,
} from "./stashFileTransaction";
import {
  assertDistinctWorktreeTargets,
  assertLocalFilesystemBoundary,
  assertSafeExistingParents,
  type CleanFile,
  ensureRecoveryRoot,
  ensureSafeParentDirectories,
  probeHardLinkSupport,
  type RawFingerprint,
  type RegularFileMode,
  type WorktreeSnapshot,
} from "./stashFileWorktreeSafety";
import { assertNoActiveContentFilters } from "./contentFilterGuard";
import {
  type PathLimitedStashRequest,
  snapshotAndValidateRequest,
  type StashFileHookContext,
} from "./stashFileValidation";

export { listPendingStashFileRecoveries } from "./stashFileTransaction";
export type {
  PathLimitedStashRequest,
  StashFileHookContext,
  StashFileTestHooks,
} from "./stashFileValidation";

const MAX_STASH_FILE_BYTES = 64 * 1024 * 1024;
const RECOVERY_SCHEMA_VERSION = 1;

type CleanupPhase = "finalization" | "index" | "preparation" | "worktree";

type IndexEntry = StashIndexEntry;

type HeadEntry = IndexEntry;

export interface StashFileResult {
  readonly safetyCopyDirectory?: string;
  readonly stashSha: string;
}

export class StashCleanupIncompleteError extends Error {
  public constructor(
    public readonly stashSha: string,
    public readonly safetyCopyDirectory: string,
    public readonly phase: CleanupPhase,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StashCleanupIncompleteError";
  }
}

export async function createPathLimitedStash(
  request: PathLimitedStashRequest,
): Promise<StashFileResult> {
  const safeRequest = snapshotAndValidateRequest(request);
  return runExclusiveRepositoryMutation(safeRequest.repositoryRoot, () =>
    createPathLimitedStashUnlocked(safeRequest),
  );
}

async function createPathLimitedStashUnlocked(
  request: PathLimitedStashRequest,
): Promise<StashFileResult> {
  const { branchName, headSha, message, pathspecs, repositoryRoot, testHooks } = request;
  const [
    status,
    unmerged,
    ,
    sparseCheckout,
    sparseIndex,
    splitIndex,
    sharedIndexPath,
    gitDirectoryOutput,
  ] = await Promise.all([
    runGit(repositoryRoot, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=no",
      "--",
      ...pathspecs,
    ]),
    runGit(repositoryRoot, ["ls-files", "--unmerged", "-z", "--", ...pathspecs]),
    assertNoActiveContentFilters(repositoryRoot, pathspecs),
    readOptionalBooleanConfig(repositoryRoot, "core.sparseCheckout"),
    readOptionalBooleanConfig(repositoryRoot, "index.sparse"),
    readOptionalBooleanConfig(repositoryRoot, "core.splitIndex"),
    runGit(repositoryRoot, ["rev-parse", "--shared-index-path"]),
    runGit(repositoryRoot, ["rev-parse", "--absolute-git-dir"]),
  ]).catch((error: unknown) =>
    failGitOperation(error, "Git could not inspect the selected file before stashing it."),
  );
  if (status.length === 0) {
    throw new Error("The selected file has no tracked changes to stash.");
  }
  if (unmerged.length > 0) {
    throw new Error("Resolve the selected file's merge conflicts before stashing it.");
  }
  if (sparseCheckout || sparseIndex) {
    throw new Error("Single-file stash is unavailable while sparse checkout is enabled.");
  }
  if (splitIndex || stripTerminalLineEnding(sharedIndexPath).length > 0) {
    throw new Error("Single-file stash is unavailable while split index is enabled.");
  }

  const gitDirectory = stripTerminalLineEnding(gitDirectoryOutput);
  if (!isAbsolute(gitDirectory) || gitDirectory.includes("\0")) {
    throw new Error("Git returned an invalid metadata directory.");
  }
  await assertOrdinaryDirectory(repositoryRoot, "Repository root");
  await assertOrdinaryDirectory(gitDirectory, "Git metadata");
  if ((await listPendingRecoveriesInGitDirectory(gitDirectory)).length > 0) {
    throw new Error(
      "RefHaven found an unfinished single-file stash recovery. Review it before creating another file stash.",
    );
  }
  const recoveryRoot = await ensureRecoveryRoot(gitDirectory);
  const recoveryDirectory = await mkdtemp(join(recoveryRoot, "stash-"));
  const recoveryRef = `refs/refhaven/stash-recovery/${randomUUID().replaceAll("-", "")}`;
  let keepRecovery = false;
  let stashSha: string | undefined;
  let phase: CleanupPhase = "preparation";
  let indexTransaction: HeldIndexTransaction | undefined;
  const evacuatedSnapshots: WorktreeSnapshot[] = [];

  try {
    const indexSnapshot = await captureIndexSnapshot(gitDirectory, recoveryDirectory);
    const initialIndexEntries = await readSelectedIndexEntries(
      repositoryRoot,
      pathspecs,
      indexSnapshot.snapshotPath,
    );
    await assertOrdinaryIndexEntries(
      repositoryRoot,
      pathspecs,
      initialIndexEntries,
      indexSnapshot.snapshotPath,
    );
    const headEntries = await readHeadEntries(repositoryRoot, headSha, pathspecs);
    await assertNoUntrackedReplacement(repositoryRoot, pathspecs, initialIndexEntries, headEntries);
    const fileModeEnabled = await readOptionalBooleanConfig(repositoryRoot, "core.fileMode", true);
    const snapshots = await captureWorktreeSnapshots(
      repositoryRoot,
      pathspecs,
      recoveryDirectory,
      initialIndexEntries,
      fileModeEnabled,
    );
    assertDistinctWorktreeTargets(snapshots);
    await assertLocalFilesystemBoundary(repositoryRoot, recoveryDirectory, snapshots);
    await probeHardLinkSupport(repositoryRoot, recoveryDirectory, snapshots);

    const temporaryIndex = join(recoveryDirectory, "selected-index");
    const temporaryWorktreeIndex = join(recoveryDirectory, "selected-worktree-index");
    const disabledHooksPath = join(recoveryDirectory, "hooks-disabled");
    const indexTree = await writeSelectedTree(
      repositoryRoot,
      headSha,
      pathspecs,
      initialIndexEntries,
      temporaryIndex,
      disabledHooksPath,
    );
    const worktreeEntries = await writeSnapshotBlobs(repositoryRoot, snapshots);
    const worktreeTree = await writeSelectedTree(
      repositoryRoot,
      headSha,
      pathspecs,
      worktreeEntries,
      temporaryWorktreeIndex,
      disabledHooksPath,
    );
    const indexCommit = parseObjectId(
      await runGitWithInput(
        repositoryRoot,
        withoutGitHooks(disabledHooksPath, ["commit-tree", indexTree, "-p", headSha]),
        `index on ${branchName}: ${headSha.slice(0, 8)} ${message}\n`,
      ),
      "Git returned an invalid stash index commit.",
    );
    stashSha = parseObjectId(
      await runGitWithInput(
        repositoryRoot,
        withoutGitHooks(disabledHooksPath, [
          "commit-tree",
          worktreeTree,
          "-p",
          headSha,
          "-p",
          indexCommit,
        ]),
        `On ${branchName}: ${message}\n`,
      ),
      "Git returned an invalid stash commit.",
    );

    const cleanIndex = await prepareCleanIndex(
      repositoryRoot,
      pathspecs,
      headEntries,
      indexSnapshot,
      disabledHooksPath,
    );
    const cleanFiles = await materializeHeadFiles(
      repositoryRoot,
      headEntries,
      snapshots,
      recoveryDirectory,
      fileModeEnabled,
    );
    await assertStateUnchanged(repositoryRoot, headSha, indexSnapshot, snapshots);
    await writeJournal(recoveryDirectory, "000-prepared", {
      createdAt: new Date().toISOString(),
      headSha,
      indexSnapshot: {
        fingerprint: fingerprint(indexSnapshot.content, indexSnapshot.permissions),
        path: indexSnapshot.snapshotPath.slice(recoveryDirectory.length + 1),
      },
      ownerProcessId: process.pid,
      paths: snapshots.map((snapshot) => ({
        backup: snapshot.backupPath.slice(recoveryDirectory.length + 1),
        filePath: snapshot.filePath,
        ...(snapshot.state === "regular"
          ? {
              fingerprint: snapshot.fingerprint,
              identity: snapshot.identity,
              mode: snapshot.mode,
              snapshot: snapshot.snapshotPath.slice(recoveryDirectory.length + 1),
            }
          : {}),
        state: snapshot.state,
      })),
      recoveryRef,
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      stashSha,
      state: "prepared",
    });

    const previousStash = await resolveOptionalCommit(repositoryRoot, "refs/stash");
    const hookContext: StashFileHookContext = {
      pathspecs,
      repositoryRoot,
      safetyCopyDirectory: recoveryDirectory,
      stashSha,
    };
    await testHooks?.beforeStashRefUpdate?.(hookContext);
    const expectedOldValue = previousStash ?? "0".repeat(stashSha.length);
    try {
      await publishStashRefs(
        repositoryRoot,
        disabledHooksPath,
        branchName,
        message,
        stashSha,
        expectedOldValue,
        recoveryRef,
      );
    } catch (error) {
      keepRecovery = true;
      const [publishedStash, publishedRecovery] = await Promise.all([
        resolveOptionalRefForPublication(repositoryRoot, "refs/stash"),
        resolveOptionalRefForPublication(repositoryRoot, recoveryRef),
      ]).catch((probeError: unknown) => {
        throw incomplete(
          hookContext.stashSha,
          recoveryDirectory,
          phase,
          "RefHaven could not determine whether Git published the stash. It retained the recovery journal and left the selected file untouched.",
          probeError,
        );
      });
      if (publishedStash !== stashSha || publishedRecovery !== stashSha) {
        if (publishedRecovery === null && publishedStash !== stashSha) {
          keepRecovery = false;
          failGitOperation(
            error,
            "Another process changed the stash list. RefHaven left the selected file untouched.",
          );
        }
        throw incomplete(
          stashSha,
          recoveryDirectory,
          phase,
          "Git reported an ambiguous stash publication. RefHaven retained the recovery journal and left the selected file untouched.",
          error,
        );
      }
    }
    keepRecovery = true;
    await writeJournal(recoveryDirectory, "100-stash-created", {
      recoveryRef,
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      stashSha,
      state: "stash-created",
    });

    phase = "worktree";
    await assertHeadUnchanged(repositoryRoot, headSha, stashSha, recoveryDirectory, phase);
    await testHooks?.beforeEvacuate?.(hookContext);
    for (const snapshot of snapshots) {
      const evacuated = await evacuatePath(repositoryRoot, snapshot);
      if (evacuated) evacuatedSnapshots.push(snapshot);
      const currentMatches = await evacuatedPathMatchesSnapshot(snapshot, evacuated);
      if (!currentMatches) {
        await restoreEvacuatedVisibility(repositoryRoot, evacuatedSnapshots);
        throw incomplete(
          hookContext.stashSha,
          recoveryDirectory,
          phase,
          "The selected file changed during stashing. RefHaven preserved the newer entry in the safety copy and did not overwrite it.",
        );
      }
    }
    await writeJournal(recoveryDirectory, "200-evacuated", {
      evacuated: evacuatedSnapshots.map(({ filePath }) => filePath),
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      stashSha,
      state: "evacuated",
    });
    await testHooks?.afterEvacuate?.(hookContext);
    await assertHeadUnchanged(repositoryRoot, headSha, stashSha, recoveryDirectory, phase);
    await publishCleanWorktree(
      repositoryRoot,
      snapshots,
      headEntries,
      cleanFiles,
      stashSha,
      recoveryDirectory,
    );
    await testHooks?.afterWorktreeCleanup?.(hookContext);

    phase = "index";
    await assertHeadUnchanged(repositoryRoot, headSha, stashSha, recoveryDirectory, phase);
    await testHooks?.beforeIndexCleanup?.(hookContext);
    await assertHeadUnchanged(repositoryRoot, headSha, stashSha, recoveryDirectory, phase);
    indexTransaction = await acquireIndexTransaction(indexSnapshot).catch((error: unknown) => {
      throw incomplete(
        hookContext.stashSha,
        recoveryDirectory,
        phase,
        "The stash is safe, but the Git index changed or is busy. RefHaven preserved the newer index state.",
        error,
      );
    });
    await indexTransaction.commit(cleanIndex).catch((error: unknown) => {
      throw incomplete(
        hookContext.stashSha,
        recoveryDirectory,
        phase,
        "The stash is safe, but the Git index could not be committed atomically. RefHaven preserved the previous index state.",
        error,
      );
    });
    indexTransaction = undefined;
    await testHooks?.afterIndexCleanup?.(hookContext);

    phase = "finalization";
    await assertCleanupComplete(
      repositoryRoot,
      headSha,
      pathspecs,
      snapshots,
      headEntries,
      cleanFiles,
      stashSha,
      recoveryDirectory,
    );
    await removePreparedFiles(snapshots, cleanFiles);
    const recoveryRefReleased = await deleteRecoveryRefWhenStashIsCurrent(
      repositoryRoot,
      disabledHooksPath,
      recoveryRef,
      stashSha,
    );
    if (!recoveryRefReleased) {
      throw incomplete(
        stashSha,
        recoveryDirectory,
        phase,
        "The selected file is clean and the stash is safe, but the stash list changed concurrently. RefHaven retained its recovery ref for review.",
      );
    }
    await writeJournal(recoveryDirectory, "300-complete", {
      recoveryRef: null,
      retainedSafetyCopies: evacuatedSnapshots.map(({ filePath }) => filePath),
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      stashSha,
      state: "complete",
    });
    if (evacuatedSnapshots.length === 0) {
      keepRecovery = false;
      return { stashSha };
    }
    return { safetyCopyDirectory: recoveryDirectory, stashSha };
  } catch (error) {
    if (stashSha !== undefined && keepRecovery) {
      await restoreEvacuatedVisibility(repositoryRoot, evacuatedSnapshots).catch(() => undefined);
      await writeJournal(recoveryDirectory, "900-incomplete", {
        phase,
        recoveryRef,
        schemaVersion: RECOVERY_SCHEMA_VERSION,
        stashSha,
        state: "incomplete",
      }).catch(() => undefined);
      if (error instanceof StashCleanupIncompleteError) throw error;
      throw incomplete(
        stashSha,
        recoveryDirectory,
        phase,
        "The stash was created, but cleanup could not finish safely. RefHaven retained a recovery journal and did not force an overwrite.",
        error,
      );
    }
    throw error;
  } finally {
    await indexTransaction?.release().catch(() => undefined);
    if (!keepRecovery) {
      await rm(recoveryDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

async function assertNoUntrackedReplacement(
  repositoryRoot: string,
  pathspecs: readonly string[],
  indexEntries: ReadonlyMap<string, IndexEntry>,
  headEntries: ReadonlyMap<string, HeadEntry>,
): Promise<void> {
  for (const filePath of pathspecs) {
    await assertSafeExistingParents(repositoryRoot, filePath);
    if (
      headEntries.has(filePath) &&
      !indexEntries.has(filePath) &&
      (await pathExists(resolvePathWithinRepository(repositoryRoot, filePath)))
    ) {
      throw new Error(
        "The selected path contains an untracked replacement for a staged deletion. RefHaven left it untouched.",
      );
    }
  }
}

async function captureWorktreeSnapshots(
  repositoryRoot: string,
  pathspecs: readonly string[],
  recoveryDirectory: string,
  indexEntries: ReadonlyMap<string, IndexEntry>,
  fileModeEnabled: boolean,
): Promise<WorktreeSnapshot[]> {
  const snapshots: WorktreeSnapshot[] = [];
  for (const [id, filePath] of pathspecs.entries()) {
    const absolutePath = resolvePathWithinRepository(repositoryRoot, filePath);
    await assertSafeExistingParents(repositoryRoot, filePath);
    const backupPath = join(recoveryDirectory, `evacuated-${id.toString()}`);
    const opened = await readRegularPath(
      absolutePath,
      "The selected file is too large to stash safely.",
    );
    if (opened === null) {
      snapshots.push({ absolutePath, backupPath, filePath, id, state: "absent" });
      continue;
    }
    const snapshotPath = join(recoveryDirectory, `snapshot-${id.toString()}`);
    await writePrivateFile(snapshotPath, opened.content, 0o600);
    const indexedMode = indexEntries.get(filePath)?.mode;
    const mode = fileModeEnabled
      ? opened.executable
        ? "100755"
        : "100644"
      : (indexedMode ?? "100644");
    snapshots.push({
      absolutePath,
      backupPath,
      filePath,
      fingerprint: fingerprint(opened.content, opened.permissions),
      id,
      identity: { device: opened.device, inode: opened.inode },
      mode,
      permissions: opened.permissions,
      snapshotPath,
      state: "regular",
    });
  }
  return snapshots;
}

async function readRegularPath(
  absolutePath: string,
  tooLargeMessage = "The selected file is too large to stash safely.",
): Promise<{
  readonly content: Buffer;
  readonly device: number;
  readonly executable: boolean;
  readonly inode: number;
  readonly permissions: number;
} | null> {
  let pathStats;
  try {
    pathStats = await lstat(absolutePath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!pathStats.isFile()) {
    throw new Error("Single-file stash supports only regular files and deletions.");
  }
  if (pathStats.size > MAX_STASH_FILE_BYTES) {
    throw new Error(tooLargeMessage);
  }
  const handle = await open(absolutePath, "r");
  try {
    const before = await handle.stat();
    if (!sameFileIdentity(pathStats, before) || !before.isFile()) {
      throw new Error("The selected file changed while it was being opened.");
    }
    if (before.size > MAX_STASH_FILE_BYTES) throw new Error(tooLargeMessage);
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const { bytesRead: overflowBytes } = await handle.read(overflowProbe, 0, 1, content.byteLength);
    const after = await handle.stat();
    if (
      !sameStableFile(before, after) ||
      offset !== content.byteLength ||
      overflowBytes !== 0 ||
      content.byteLength !== after.size
    ) {
      throw new Error("The selected file changed while it was being captured.");
    }
    return {
      content,
      device: after.dev,
      executable: (after.mode & 0o111) !== 0,
      inode: after.ino,
      permissions: after.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

async function readSelectedIndexEntries(
  repositoryRoot: string,
  pathspecs: readonly string[],
  temporaryIndex?: string,
): Promise<Map<string, IndexEntry>> {
  const args = ["ls-files", "--stage", "-z", "--", ...pathspecs];
  const output = temporaryIndex
    ? await runGitWithTemporaryIndex(repositoryRoot, args, temporaryIndex)
    : await runGit(repositoryRoot, args);
  const expected = new Set(pathspecs);
  const entries = new Map<string, IndexEntry>();
  for (const record of splitNulRecords(output)) {
    const tab = record.indexOf("\t");
    if (tab <= 0) throw new Error("Git returned a malformed index entry.");
    const [mode, objectId, stage, extra] = record.slice(0, tab).split(" ");
    const filePath = record.slice(tab + 1);
    if (
      extra !== undefined ||
      stage !== "0" ||
      !isRegularMode(mode) ||
      !isGitObjectId(objectId) ||
      /^0+$/u.test(objectId) ||
      !expected.has(filePath) ||
      entries.has(filePath)
    ) {
      throw new Error("The selected index state is unsupported or malformed.");
    }
    entries.set(filePath, { filePath, mode, objectId });
  }
  return entries;
}

async function readHeadEntries(
  repositoryRoot: string,
  headSha: string,
  pathspecs: readonly string[],
): Promise<Map<string, HeadEntry>> {
  const output = await runGit(repositoryRoot, [
    "ls-tree",
    "-z",
    "--full-tree",
    headSha,
    "--",
    ...pathspecs,
  ]);
  const expected = new Set(pathspecs);
  const entries = new Map<string, HeadEntry>();
  for (const record of splitNulRecords(output)) {
    const tab = record.indexOf("\t");
    if (tab <= 0) throw new Error("Git returned a malformed HEAD entry.");
    const [mode, type, objectId, extra] = record.slice(0, tab).split(" ");
    const filePath = record.slice(tab + 1);
    if (
      extra !== undefined ||
      type !== "blob" ||
      !isRegularMode(mode) ||
      !isGitObjectId(objectId) ||
      !expected.has(filePath) ||
      entries.has(filePath)
    ) {
      throw new Error("Single-file stash does not support this HEAD entry type.");
    }
    entries.set(filePath, { filePath, mode, objectId });
  }
  return entries;
}

async function assertOrdinaryIndexEntries(
  repositoryRoot: string,
  pathspecs: readonly string[],
  entries: ReadonlyMap<string, IndexEntry>,
  temporaryIndex?: string,
): Promise<void> {
  const args = ["ls-files", "-v", "-z", "--", ...pathspecs];
  const output = temporaryIndex
    ? await runGitWithTemporaryIndex(repositoryRoot, args, temporaryIndex)
    : await runGit(repositoryRoot, args);
  const tags = new Map<string, string>();
  for (const record of splitNulRecords(output)) {
    if (record.length < 3 || record[1] !== " ") {
      throw new Error("Git returned malformed index flags.");
    }
    tags.set(record.slice(2), record[0] ?? "");
  }
  for (const filePath of entries.keys()) {
    if (tags.get(filePath) !== "H") {
      throw new Error("Single-file stash does not support special or sparse index entries.");
    }
  }
}

async function writeSnapshotBlobs(
  repositoryRoot: string,
  snapshots: readonly WorktreeSnapshot[],
): Promise<Map<string, IndexEntry>> {
  const entries = new Map<string, IndexEntry>();
  for (const snapshot of snapshots) {
    if (snapshot.state === "absent") continue;
    const objectId = parseObjectId(
      await runGit(repositoryRoot, [
        "hash-object",
        "-w",
        `--path=${snapshot.filePath}`,
        "--",
        snapshot.snapshotPath,
      ]),
      "Git returned an invalid worktree blob.",
    );
    entries.set(snapshot.filePath, {
      filePath: snapshot.filePath,
      mode: snapshot.mode,
      objectId,
    });
  }
  return entries;
}

async function writeSelectedTree(
  repositoryRoot: string,
  headSha: string,
  pathspecs: readonly string[],
  entries: ReadonlyMap<string, IndexEntry>,
  temporaryIndex: string,
  disabledHooksPath: string,
): Promise<string> {
  await runGitWithTemporaryIndex(
    repositoryRoot,
    withoutGitHooks(disabledHooksPath, ["read-tree", headSha]),
    temporaryIndex,
  );
  await runGitWithTemporaryIndex(
    repositoryRoot,
    withoutGitHooks(disabledHooksPath, ["update-index", "--force-remove", "--", ...pathspecs]),
    temporaryIndex,
  );
  if (entries.size > 0) {
    await runGitWithInput(
      repositoryRoot,
      withoutGitHooks(disabledHooksPath, ["update-index", "-z", "--index-info"]),
      encodeIndexEntries(entries.values()),
      undefined,
      { temporaryIndex },
    );
  }
  return parseObjectId(
    await runGitWithTemporaryIndex(
      repositoryRoot,
      withoutGitHooks(disabledHooksPath, ["write-tree"]),
      temporaryIndex,
    ),
    "Git returned an invalid selected tree.",
  );
}

async function materializeHeadFiles(
  repositoryRoot: string,
  headEntries: ReadonlyMap<string, HeadEntry>,
  snapshots: readonly WorktreeSnapshot[],
  recoveryDirectory: string,
  fileModeEnabled: boolean,
): Promise<Map<string, CleanFile>> {
  const cleanFiles = new Map<string, CleanFile>();
  let id = 0;
  for (const entry of headEntries.values()) {
    const cleanPath = join(recoveryDirectory, `clean-${id.toString()}`);
    id += 1;
    const content = await runGitBuffer(
      repositoryRoot,
      ["cat-file", "--filters", `--path=${entry.filePath}`, entry.objectId],
      undefined,
      MAX_STASH_FILE_BYTES,
    );
    const snapshot = snapshots.find(({ filePath }) => filePath === entry.filePath);
    const permissions = cleanWorktreePermissions(
      snapshot?.state === "regular" ? snapshot.permissions : undefined,
      entry.mode,
      fileModeEnabled,
    );
    await writePrivateFile(cleanPath, content, permissions);
    const preparedPermissions = (await lstat(cleanPath)).mode & 0o777;
    cleanFiles.set(entry.filePath, {
      fingerprint: fingerprint(content, preparedPermissions),
      preparedPath: cleanPath,
    });
  }
  return cleanFiles;
}

async function assertStateUnchanged(
  repositoryRoot: string,
  headSha: string,
  indexSnapshot: IndexSnapshot,
  snapshots: readonly WorktreeSnapshot[],
): Promise<void> {
  const [currentHead, currentIndex] = await Promise.all([
    resolveHead(repositoryRoot),
    readIndexContent(indexSnapshot.indexPath),
  ]);
  if (currentHead !== headSha || !indexSnapshot.content.equals(currentIndex)) {
    throw new Error("HEAD or the Git index changed while the stash was prepared.");
  }
  for (const snapshot of snapshots) {
    if (!(await pathMatchesSnapshot(snapshot))) {
      throw new Error("The selected file changed while the stash was prepared.");
    }
  }
}

async function assertHeadUnchanged(
  repositoryRoot: string,
  headSha: string,
  stashSha: string,
  recoveryDirectory: string,
  phase: CleanupPhase,
): Promise<void> {
  if ((await resolveHead(repositoryRoot)) !== headSha) {
    throw incomplete(
      stashSha,
      recoveryDirectory,
      phase,
      "The stash is safe, but HEAD changed before cleanup. RefHaven did not overwrite the newer repository state.",
    );
  }
}

async function evacuatePath(repositoryRoot: string, snapshot: WorktreeSnapshot): Promise<boolean> {
  await assertSafeExistingParents(repositoryRoot, snapshot.filePath);
  try {
    await rename(snapshot.absolutePath, snapshot.backupPath);
    await Promise.all([
      syncDirectory(dirname(snapshot.absolutePath)),
      syncDirectory(dirname(snapshot.backupPath)),
    ]);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function evacuatedPathMatchesSnapshot(
  snapshot: WorktreeSnapshot,
  evacuated: boolean,
): Promise<boolean> {
  if (snapshot.state === "absent") return !evacuated;
  if (!evacuated) return false;
  const current = await readRegularPath(snapshot.backupPath);
  return (
    current !== null &&
    sameSnapshotIdentity(snapshot.identity, current) &&
    sameFingerprint(snapshot.fingerprint, fingerprint(current.content, current.permissions))
  );
}

async function pathMatchesSnapshot(snapshot: WorktreeSnapshot): Promise<boolean> {
  const current = await readRegularPath(snapshot.absolutePath);
  if (snapshot.state === "absent") return current === null;
  return (
    current !== null &&
    sameSnapshotIdentity(snapshot.identity, current) &&
    sameFingerprint(snapshot.fingerprint, fingerprint(current.content, current.permissions))
  );
}

async function restoreEvacuatedVisibility(
  repositoryRoot: string,
  snapshots: readonly WorktreeSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots) {
    await ensureSafeParentDirectories(repositoryRoot, snapshot.filePath);
    let restored = false;
    try {
      await link(snapshot.backupPath, snapshot.absolutePath);
      restored = true;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    if (restored) await syncDirectory(dirname(snapshot.absolutePath));
  }
}

async function publishCleanWorktree(
  repositoryRoot: string,
  snapshots: readonly WorktreeSnapshot[],
  headEntries: ReadonlyMap<string, HeadEntry>,
  cleanFiles: ReadonlyMap<string, CleanFile>,
  stashSha: string,
  recoveryDirectory: string,
): Promise<void> {
  for (const snapshot of snapshots) {
    const headEntry = headEntries.get(snapshot.filePath);
    if (headEntry === undefined) {
      if (await pathExists(snapshot.absolutePath)) {
        throw incomplete(
          stashSha,
          recoveryDirectory,
          "worktree",
          "The stash is safe, but another process recreated the selected path. RefHaven left the newer file untouched.",
        );
      }
      continue;
    }
    const cleanFile = cleanFiles.get(snapshot.filePath);
    if (!cleanFile) throw new Error("The prepared HEAD file is missing.");
    await ensureSafeParentDirectories(repositoryRoot, snapshot.filePath);
    await link(cleanFile.preparedPath, snapshot.absolutePath).catch((error: unknown) => {
      if (isErrorCode(error, "EEXIST")) {
        throw incomplete(
          stashSha,
          recoveryDirectory,
          "worktree",
          "The stash is safe, but another process wrote the selected path during cleanup. RefHaven left the newer file untouched.",
        );
      }
      throw error;
    });
    await syncDirectory(dirname(snapshot.absolutePath));
  }
}

async function assertCleanupComplete(
  repositoryRoot: string,
  headSha: string,
  pathspecs: readonly string[],
  snapshots: readonly WorktreeSnapshot[],
  headEntries: ReadonlyMap<string, HeadEntry>,
  cleanFiles: ReadonlyMap<string, CleanFile>,
  stashSha: string,
  recoveryDirectory: string,
): Promise<void> {
  await assertHeadUnchanged(repositoryRoot, headSha, stashSha, recoveryDirectory, "finalization");
  const currentIndexEntries = await readSelectedIndexEntries(repositoryRoot, pathspecs);
  await assertOrdinaryIndexEntries(repositoryRoot, pathspecs, currentIndexEntries);
  if (!sameEntries(currentIndexEntries, headEntries)) {
    throw incomplete(
      stashSha,
      recoveryDirectory,
      "finalization",
      "The stash is safe, but the selected index entry changed immediately after cleanup. RefHaven preserved the newer state.",
    );
  }

  for (const snapshot of snapshots) {
    await assertSafeExistingParents(repositoryRoot, snapshot.filePath);
    const headEntry = headEntries.get(snapshot.filePath);
    if (headEntry === undefined) {
      if (await pathExists(snapshot.absolutePath)) {
        throw incomplete(
          stashSha,
          recoveryDirectory,
          "finalization",
          "The stash is safe, but another process recreated the selected path after cleanup. RefHaven left it untouched.",
        );
      }
      continue;
    }
    const expected = cleanFiles.get(snapshot.filePath);
    const current = await readRegularPath(snapshot.absolutePath);
    if (
      !expected ||
      current === null ||
      !sameFingerprint(expected.fingerprint, fingerprint(current.content, current.permissions))
    ) {
      throw incomplete(
        stashSha,
        recoveryDirectory,
        "finalization",
        "The stash is safe, but another process changed the selected file after cleanup. RefHaven did not overwrite the newer state.",
      );
    }
  }
}

async function removePreparedFiles(
  snapshots: readonly WorktreeSnapshot[],
  cleanFiles: ReadonlyMap<string, CleanFile>,
): Promise<void> {
  await Promise.all([
    ...snapshots.flatMap((snapshot) =>
      snapshot.state === "regular" ? [unlink(snapshot.snapshotPath).catch(() => undefined)] : [],
    ),
    ...[...cleanFiles.values()].map(({ preparedPath }) =>
      unlink(preparedPath).catch(() => undefined),
    ),
  ]);
}

async function resolveOptionalCommit(repositoryRoot: string, ref: string): Promise<string | null> {
  const output = await runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]).catch((error: unknown) => preserveControlErrorOrNull(error));
  return output === null ? null : parseObjectId(output, `Git returned an invalid ${ref} revision.`);
}

async function resolveOptionalRefForPublication(
  repositoryRoot: string,
  ref: string,
): Promise<string | null> {
  const output = await runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    ref,
  ]).catch((error: unknown) => {
    const normalized = normalizeGitError(error);
    if (normalized instanceof GitOperationError) throw normalized;
    if ((normalized as { readonly code?: unknown }).code === 1) return null;
    throw new Error("Git could not verify stash publication.", { cause: normalized });
  });
  return output === null ? null : parseObjectId(output, "Git returned an invalid published ref.");
}

async function resolveHead(repositoryRoot: string): Promise<string> {
  return parseObjectId(
    await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "Git returned an invalid HEAD revision.",
  );
}

async function readOptionalBooleanConfig(
  repositoryRoot: string,
  key: string,
  defaultValue = false,
): Promise<boolean> {
  const output = await runGit(repositoryRoot, ["config", "--bool", key]).catch((error: unknown) =>
    preserveMissingConfigOrThrow(error),
  );
  if (output === null) return defaultValue;
  const value = output.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Git returned an invalid boolean configuration value.");
}

async function writeJournal(
  recoveryDirectory: string,
  label: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writePrivateFile(
    join(recoveryDirectory, `journal-${label}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    0o600,
  );
  await syncDirectory(recoveryDirectory);
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

function fingerprint(content: Buffer, permissions: number): RawFingerprint {
  return {
    permissions,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.byteLength,
  };
}

function sameFingerprint(left: RawFingerprint, right: RawFingerprint): boolean {
  return (
    left.permissions === right.permissions &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function sameSnapshotIdentity(
  expected: { readonly device: number; readonly inode: number },
  current: { readonly device: number; readonly inode: number },
): boolean {
  return (
    expected.device === current.device &&
    (expected.inode === 0 || current.inode === 0 || expected.inode === current.inode)
  );
}

function sameEntries(
  left: ReadonlyMap<string, IndexEntry>,
  right: ReadonlyMap<string, IndexEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [filePath, entry] of left) {
    const other = right.get(filePath);
    if (other?.mode !== entry.mode || other.objectId !== entry.objectId) return false;
  }
  return true;
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

function splitNulRecords(output: string): string[] {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  return records;
}

function isRegularMode(value: string | undefined): value is RegularFileMode {
  return value === "100644" || value === "100755";
}

function parseObjectId(output: string, errorMessage: string): string {
  return requireGitObjectId(output.trim(), errorMessage);
}

function withoutGitHooks(hooksPath: string, args: readonly string[]): string[] {
  return ["-c", `core.hooksPath=${hooksPath}`, ...args];
}

function incomplete(
  stashSha: string,
  recoveryDirectory: string,
  phase: CleanupPhase,
  message: string,
  cause?: unknown,
): StashCleanupIncompleteError {
  return new StashCleanupIncompleteError(stashSha, recoveryDirectory, phase, message, {
    cause,
  });
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as { readonly code?: unknown }).code === code;
}

function failGitOperation(error: unknown, safeMessage: string): never {
  const normalized = normalizeGitError(error);
  if (normalized instanceof GitOperationError) throw normalized;
  throw new Error(safeMessage, { cause: normalized });
}

function preserveControlErrorOrNull(error: unknown): null {
  const normalized = normalizeGitError(error);
  if (normalized instanceof GitOperationError) throw normalized;
  return null;
}

function preserveMissingConfigOrThrow(error: unknown): null {
  const normalized = normalizeGitError(error);
  if (normalized instanceof GitOperationError) throw normalized;
  if ((normalized as { readonly code?: unknown }).code === 1) return null;
  throw new Error("Git could not inspect the repository configuration.", { cause: normalized });
}
