import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  previewMerge,
  resetMergePreviewSupportCache,
} from "../../src/infrastructure/git/mergePreview";

suite("merge preview driver isolation", () => {
  test("does not execute a custom driver selected by repository attributes", async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "refhaven-merge-driver-test-"));
    const git = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        windowsHide: true,
      }).trim();

    try {
      git("init", "--initial-branch=main");
      git("config", "user.name", "RefHaven Tests");
      git("config", "user.email", "refhaven@example.invalid");
      git("config", "core.hooksPath", join(repositoryRoot, ".git", "disabled-hooks"));

      writeFileSync(join(repositoryRoot, ".gitattributes"), "conflict.txt merge=audit\n", "utf8");
      writeFileSync(join(repositoryRoot, "conflict.txt"), "base\n", "utf8");
      git("add", "--", ".gitattributes", "conflict.txt");
      git("commit", "--no-gpg-sign", "-m", "base");
      const baseSha = git("rev-parse", "HEAD");

      git("switch", "-c", "left");
      writeFileSync(join(repositoryRoot, "conflict.txt"), "left\n", "utf8");
      git("add", "--", "conflict.txt");
      git("commit", "--no-gpg-sign", "-m", "left");
      const leftSha = git("rev-parse", "HEAD");

      git("switch", "-c", "right", baseSha);
      writeFileSync(join(repositoryRoot, "conflict.txt"), "right\n", "utf8");
      git("add", "--", "conflict.txt");
      git("commit", "--no-gpg-sign", "-m", "right");
      const rightSha = git("rev-parse", "HEAD");

      // If merge-tree starts this harmless audit driver, it leaves a marker in
      // the fixture's local config. The hardened preview must stop beforehand.
      git("config", "merge.audit.driver", "git config --local refhaven.audit-driver-ran yes");
      resetMergePreviewSupportCache();

      assert.deepEqual(await previewMerge(repositoryRoot, leftSha, rightSha), {
        kind: "unavailable",
      });

      const marker = spawnSync("git", ["config", "--local", "--get", "refhaven.audit-driver-ran"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(marker.error, undefined);
      assert.equal(marker.status, 1, `unexpected driver marker: ${marker.stdout}`);
      assert.equal(marker.stdout, "");
    } finally {
      try {
        rmSync(repositoryRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
      } catch {
        // Best-effort cleanup under a unique system temporary directory.
      }
    }
  });
});
