import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildCanonicalRepositoryIdentities,
  buildRepositoryIdentities,
  canonicalPathIdentityKey,
} from "../../src/infrastructure/git/repositoryDiscovery";

suite("repository identity discovery", () => {
  test("keeps nested repositories discovered by the VS Code Git API", () => {
    const workspace = resolve("workspace");
    const nested = join(workspace, "packages", "nested-repository");
    assert.deepEqual(
      buildRepositoryIdentities(
        [nested],
        [{ name: "workspace", rootPath: workspace, uri: "file:///workspace" }],
      ),
      [
        {
          label: "workspace/packages/nested-repository",
          relativeRepositoryPath: join("packages", "nested-repository"),
          rootPath: nested,
          workspaceFolderUri: "file:///workspace",
        },
      ],
    );
  });

  test("deduplicates identical roots and ignores unrelated repositories", () => {
    const workspace = resolve("workspace");
    const repository = join(workspace, "repository");
    assert.equal(
      buildRepositoryIdentities(
        [repository, repository, resolve("elsewhere")],
        [{ name: "workspace", rootPath: workspace, uri: "file:///workspace" }],
      ).length,
      1,
    );
  });

  test("accepts the containing repository when a trusted subfolder is opened", () => {
    const repository = resolve("repository");
    const workspace = join(repository, "packages", "opened-folder");

    assert.deepEqual(
      buildRepositoryIdentities(
        [repository],
        [{ name: "opened-folder", rootPath: workspace, uri: "file:///opened-folder" }],
      ),
      [
        {
          label: "repository (opened-folder)",
          relativeRepositoryPath: join("..", ".."),
          rootPath: repository,
          workspaceFolderUri: "file:///opened-folder",
        },
      ],
    );
  });

  test("associates a repository with the nearest related workspace folder", () => {
    const repository = resolve("repository");
    const packageFolder = join(repository, "packages");
    const openedFolder = join(packageFolder, "opened-folder");

    assert.equal(
      buildRepositoryIdentities(
        [repository],
        [
          { name: "opened-folder", rootPath: openedFolder, uri: "file:///opened-folder" },
          { name: "packages", rootPath: packageFolder, uri: "file:///packages" },
        ],
      )[0]?.workspaceFolderUri,
      "file:///packages",
    );
  });

  test("rejects a repository reached through a symlink escape", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "refhaven-repository-discovery-"));
    const workspace = join(fixture, "workspace");
    const outsideRepository = join(fixture, "outside-repository");
    const linkedRepository = join(workspace, "linked-repository");
    try {
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(outsideRepository, { recursive: true }),
      ]);
      await symlink(
        outsideRepository,
        linkedRepository,
        process.platform === "win32" ? "junction" : "dir",
      );

      assert.deepEqual(
        await buildCanonicalRepositoryIdentities(
          [linkedRepository],
          [{ name: "workspace", rootPath: workspace, uri: "file:///workspace" }],
        ),
        [],
      );
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });

  test("uses one identity for equivalent paths reached through a filesystem alias", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "refhaven-repository-alias-"));
    const target = join(fixture, "target");
    const repository = join(target, "repository");
    const alias = join(fixture, "alias");
    try {
      await mkdir(repository, { recursive: true });
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

      assert.equal(
        await canonicalPathIdentityKey(join(alias, "repository")),
        await canonicalPathIdentityKey(repository),
      );
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  });
});
