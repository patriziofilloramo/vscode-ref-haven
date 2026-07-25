import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface CommandContribution {
  readonly command: string;
}

interface MenuContribution {
  readonly command?: string;
  readonly submenu?: string;
  readonly when?: string;
}

interface PackageManifest {
  readonly activationEvents: readonly string[];
  readonly contributes: {
    readonly commands: readonly CommandContribution[];
    readonly configuration: {
      readonly properties: Readonly<
        Record<
          string,
          { readonly default: unknown; readonly maximum?: number; readonly minimum?: number }
        >
      >;
    };
    readonly menus: Readonly<Record<string, readonly MenuContribution[]>>;
    readonly submenus: readonly { readonly id: string; readonly label: string }[];
    readonly views: {
      readonly scm: readonly { readonly id: string; readonly name: string }[];
    };
  };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly description: string;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly displayName: string;
  readonly files: readonly string[];
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
}

function loadManifest(): PackageManifest {
  const manifestPath = resolve(__dirname, "../../../package.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
}

suite("extension manifest", () => {
  test("declares the canonical RefHaven identity", () => {
    const manifest = loadManifest();

    assert.equal(manifest.name, "refhaven");
    assert.equal(manifest.displayName, "RefHaven");
    assert.equal(manifest.publisher, "local-development");
    assert.equal(manifest.version, "0.7.1");
    assert.match(manifest.description, /local processing/u);
  });

  test("contributes the RefHaven views to Source Control", () => {
    const manifest = loadManifest();

    assert.deepEqual(manifest.contributes.views.scm, [
      { id: "refhaven.comparisons", name: "Branch Comparisons" },
      { id: "refhaven.stashes", name: "Stashes" },
      { id: "refhaven.fileHistory", name: "File History" },
      { id: "refhaven.commitDetails", name: "Commit Details" },
      { id: "refhaven.branches", name: "Branches" },
      { id: "refhaven.worktrees", name: "Worktrees" },
    ]);
    assert.deepEqual(
      manifest.activationEvents,
      [],
      "VS Code derives activation events from the view and command contributions",
    );
  });

  test("declares every user-facing command", () => {
    const manifest = loadManifest();
    const commands = manifest.contributes.commands.map(({ command }) => command).sort();

    assert.deepEqual(commands, [
      "refhaven.changeComparisonFileFilter",
      "refhaven.changeComparisonFileSort",
      "refhaven.changeComparisonMode",
      "refhaven.changeFileAnnotations",
      "refhaven.changeFileHistoryFilter",
      "refhaven.changeStashFilter",
      "refhaven.closeComparison",
      "refhaven.compareBranchWithCurrent",
      "refhaven.compareCommitWithParent",
      "refhaven.compareCurrentBranch",
      "refhaven.compareFileWithRevision",
      "refhaven.compareStashFileWithHead",
      "refhaven.compareStashFileWithWorkingTree",
      "refhaven.copyBranchName",
      "refhaven.copyCommitDetail",
      "refhaven.copyCommitMessage",
      "refhaven.copyCommitSha",
      "refhaven.copyComparisonSummary",
      "refhaven.copyFilePath",
      "refhaven.copyRelativeFilePath",
      "refhaven.copyStashMessage",
      "refhaven.copyStashSha",
      "refhaven.copyWorktreePath",
      "refhaven.findOtherStashesContainingFile",
      "refhaven.markAllComparisonFilesReviewed",
      "refhaven.markFileReviewed",
      "refhaven.markFileUnreviewed",
      "refhaven.newComparison",
      "refhaven.nextUnreviewedFile",
      "refhaven.openChangedFileAtRevision",
      "refhaven.openCommitParentDetails",
      "refhaven.openFile",
      "refhaven.openFileAtRevision",
      "refhaven.openFileHistoryAtRevision",
      "refhaven.openFileHistoryDiff",
      "refhaven.openGitLabBranch",
      "refhaven.openGitLabCommit",
      "refhaven.openGitLabComparison",
      "refhaven.openGitLabFile",
      "refhaven.openGitLabLocalReference",
      "refhaven.openGitLabProject",
      "refhaven.openGitLabReference",
      "refhaven.openLineDiff",
      "refhaven.openNextFileHistoryRevision",
      "refhaven.openPreviousFileHistoryRevision",
      "refhaven.openStashFileAtRevision",
      "refhaven.openWorktree",
      "refhaven.pinComparison",
      "refhaven.previousUnreviewedFile",
      "refhaven.quickOpenComparisonFile",
      "refhaven.refreshAll",
      "refhaven.refreshComparison",
      "refhaven.refreshFileHistory",
      "refhaven.refreshRepositoryNavigation",
      "refhaven.refreshStashes",
      "refhaven.resetComparisonReview",
      "refhaven.searchCommits",
      "refhaven.showCommitDetails",
      "refhaven.showFileHistory",
      "refhaven.showLineBlameActions",
      "refhaven.showLineHistory",
      "refhaven.showRefHavenMenu",
      "refhaven.showStashCommitDetails",
      "refhaven.stashFile",
      "refhaven.swapComparison",
      "refhaven.toggleInlineBlame",
      "refhaven.unpinComparison",
      "refhaven.viewFilesAsList",
      "refhaven.viewFilesAsTree",
    ]);
    assert.ok(commands.every((command) => command.startsWith("refhaven.")));
  });

  test("exposes one consistent native file-actions menu", () => {
    const manifest = loadManifest();

    assert.deepEqual(manifest.contributes.submenus, [
      { id: "refhaven.fileActions", label: "RefHaven" },
    ]);
    assert.ok(
      manifest.contributes.menus["editor/context"]?.some(
        ({ submenu }) => submenu === "refhaven.fileActions",
      ),
    );
    assert.ok(
      manifest.contributes.menus["explorer/context"]?.some(
        ({ submenu }) => submenu === "refhaven.fileActions",
      ),
    );
    assert.ok(
      manifest.contributes.menus["scm/resourceState/context"]?.some(
        ({ submenu }) => submenu === "refhaven.fileActions",
      ),
    );
    assert.ok(
      manifest.contributes.menus["editor/title"]?.some(
        ({ command }) => command === "refhaven.showRefHavenMenu",
      ),
    );
    const fileActions =
      manifest.contributes.menus["refhaven.fileActions"]?.map(({ command }) => command) ?? [];
    assert.deepEqual(fileActions, [
      "refhaven.showFileHistory",
      "refhaven.showLineHistory",
      "refhaven.openFileAtRevision",
      "refhaven.compareFileWithRevision",
      "refhaven.changeFileAnnotations",
      "refhaven.stashFile",
      "refhaven.openGitLabFile",
      "refhaven.openGitLabReference",
    ]);
  });

  test("exposes native comparison review controls only on review-capable nodes", () => {
    const manifest = loadManifest();
    const titleCommands =
      manifest.contributes.menus["view/title"]?.map(({ command }) => command) ?? [];
    for (const command of [
      "refhaven.quickOpenComparisonFile",
      "refhaven.nextUnreviewedFile",
      "refhaven.changeComparisonFileFilter",
      "refhaven.changeComparisonFileSort",
    ]) {
      assert.ok(titleCommands.includes(command));
    }

    const itemMenus = manifest.contributes.menus["view/item/context"] ?? [];
    assert.ok(
      itemMenus.some(
        ({ command, when }) =>
          command === "refhaven.markFileReviewed" && when?.includes("\\.unreviewed$"),
      ),
    );
    assert.ok(
      itemMenus.some(
        ({ command, when }) =>
          command === "refhaven.markFileUnreviewed" && when?.includes("\\.reviewed$"),
      ),
    );
    for (const command of ["refhaven.nextUnreviewedFile", "refhaven.previousUnreviewedFile"]) {
      assert.ok(
        itemMenus.some(
          ({ command: candidate, when }) =>
            candidate === command && when?.includes("(reviewed|unreviewed)"),
        ),
      );
    }
  });

  test("packages only compiled runtime files", () => {
    const manifest = loadManifest();

    assert.deepEqual(manifest.files, ["dist/**/*.js", "SECURITY.md"]);
  });

  test("has no runtime dependencies and exact-pins the minimal development toolchain", () => {
    const manifest = loadManifest();

    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.devDependencies.rimraf, undefined);
    assert.equal(manifest.devDependencies["@vscode/test-cli"], undefined);
    for (const [name, version] of Object.entries(manifest.devDependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/u, `${name} must use an exact version`);
    }
  });

  test("declares a bounded Git command timeout", () => {
    const setting = manifestSetting(loadManifest(), "refhaven.git.timeoutSeconds");
    assert.equal(setting.default, 30);
    assert.equal(setting.minimum, 1);
    assert.equal(setting.maximum, 300);
  });

  test("keeps whole-file annotations opt-in", () => {
    const setting = manifestSetting(loadManifest(), "refhaven.fileAnnotations.mode");
    assert.equal(setting.default, "off");
  });

  test("enables rich local line hover by default", () => {
    const setting = manifestSetting(loadManifest(), "refhaven.lineHover.enabled");
    assert.equal(setting.default, true);
  });

  test("requires explicit GitLab origin approval", () => {
    const setting = manifestSetting(loadManifest(), "refhaven.gitLab.approvedOrigins");
    assert.deepEqual(setting.default, []);
  });
});

function manifestSetting(
  manifest: PackageManifest,
  key: string,
): { readonly default: unknown; readonly maximum?: number; readonly minimum?: number } {
  const setting = manifest.contributes.configuration.properties[key];
  assert.ok(setting, `Expected manifest setting ${key}`);
  return setting;
}
