import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  EXTENSION_SETTING_DEFAULTS,
  EXTENSION_SETTING_LIMITS,
  EXTENSION_SETTINGS,
  extensionSettingPath,
  type ExtensionSetting,
} from "../../src/config/extensionConfigurationSchema";

interface CommandContribution {
  readonly category?: string;
  readonly command: string;
  readonly icon?: string;
  readonly title?: string;
}

interface MenuContribution {
  readonly command?: string;
  readonly group?: string;
  readonly submenu?: string;
  readonly when?: string;
}

interface PackageManifest {
  readonly activationEvents: readonly string[];
  readonly capabilities: {
    readonly untrustedWorkspaces: { readonly supported: boolean };
    readonly virtualWorkspaces: { readonly supported: boolean };
  };
  readonly contributes: {
    readonly commands: readonly CommandContribution[];
    readonly configuration: {
      readonly properties: Readonly<
        Record<
          string,
          {
            readonly default: unknown;
            readonly description?: string;
            readonly maximum?: number;
            readonly minimum?: number;
          }
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
  readonly engines: { readonly node: string; readonly vscode: string };
  readonly files: readonly string[];
  readonly icon: string;
  readonly license: string;
  readonly name: string;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly private: boolean;
  readonly publisher: string;
  readonly repository?: { readonly url: string };
  readonly scripts: Readonly<Record<string, string>>;
  readonly version: string;
}

interface PackageLock {
  readonly name: string;
  readonly packages: Readonly<
    Partial<Record<string, { readonly name?: string; readonly version?: string }>>
  >;
  readonly version: string;
}

function loadManifest(): PackageManifest {
  const manifestPath = resolve(__dirname, "../../../package.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
}

function loadPackageLock(): PackageLock {
  const lockPath = resolve(__dirname, "../../../package-lock.json");
  return JSON.parse(readFileSync(lockPath, "utf8")) as PackageLock;
}

suite("extension manifest", () => {
  test("declares the canonical RefHaven identity", () => {
    const manifest = loadManifest();

    assert.equal(manifest.name, "refhaven");
    assert.equal(manifest.displayName, "RefHaven");
    assert.equal(manifest.publisher, "patriziofilloramo");
    assert.equal(manifest.version, "0.13.9");
    assert.match(manifest.description, /local processing/u);
  });

  test("permits VSIX release packaging while blocking accidental npm publish", () => {
    const manifest = loadManifest();

    assert.equal(manifest.private, true);
    assert.equal(manifest.publisher, "patriziofilloramo");
    assert.equal(manifest.license, "MIT");
    assert.match(
      manifest.repository?.url ?? "",
      /github\.com\/patriziofilloramo\/vscode-ref-haven/u,
    );
    assert.equal(
      manifest.scripts["package:release"],
      "npm run marketplace:check && vsce package --no-dependencies --out build",
    );
    assert.equal(
      manifest.scripts["marketplace:check"],
      "node scripts/check-marketplace-readiness.mjs",
    );
    assert.equal(
      manifest.scripts["compile:tests"],
      "node scripts/clean-test-output.mjs && tsc -p test/tsconfig.json",
    );
  });

  test("keeps package-lock release metadata aligned with the manifest", () => {
    const manifest = loadManifest();
    const lock = loadPackageLock();
    const rootPackage = lock.packages[""];

    assert.equal(lock.name, manifest.name);
    assert.equal(lock.version, manifest.version);
    assert.ok(rootPackage);
    assert.equal(rootPackage.name, manifest.name);
    assert.equal(rootPackage.version, manifest.version);
  });

  test("uses maintained Node LTS lines for development tooling", () => {
    const manifest = loadManifest();

    assert.equal(manifest.engines.node, "^22.13.0 || ^24.0.0");
    assert.equal(manifest.engines.vscode, "^1.105.0");
  });

  test("contributes the RefHaven views to Source Control", () => {
    const manifest = loadManifest();

    assert.deepEqual(manifest.contributes.views.scm, [
      { id: "refhaven.comparisons", name: "Branch Comparisons" },
      { id: "refhaven.stashes", name: "Stashes" },
      { id: "refhaven.inspector", name: "Inspector" },
      { id: "refhaven.repository", name: "Repository" },
    ]);
    assert.deepEqual(
      manifest.activationEvents,
      ["onStartupFinished"],
      "Always-on line intelligence must register its providers after startup",
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
      "refhaven.changeLineIntelligence",
      "refhaven.changeStashFilter",
      "refhaven.closeComparison",
      "refhaven.compareBranchWithCurrent",
      "refhaven.compareCommitWithParent",
      "refhaven.compareCurrentBranch",
      "refhaven.compareFileWithRevision",
      "refhaven.compareSelectedBranches",
      "refhaven.compareStashFileWithHead",
      "refhaven.compareStashFileWithWorkingTree",
      "refhaven.configureBrowserOrigin",
      "refhaven.copyBranchName",
      "refhaven.copyBrowserBranchUrl",
      "refhaven.copyBrowserCommitUrl",
      "refhaven.copyBrowserComparisonUrl",
      "refhaven.copyBrowserFileUrl",
      "refhaven.copyBrowserProjectUrl",
      "refhaven.copyCommitDetail",
      "refhaven.copyCommitMessage",
      "refhaven.copyCommitSha",
      "refhaven.copyComparisonPatch",
      "refhaven.copyComparisonSummary",
      "refhaven.copyFilePatch",
      "refhaven.copyFilePath",
      "refhaven.copyRelativeFilePath",
      "refhaven.copyStashMessage",
      "refhaven.copyStashSha",
      "refhaven.copyWorktreePath",
      "refhaven.findOtherStashesContainingFile",
      "refhaven.inspectCurrentLine",
      "refhaven.markAllComparisonFilesReviewed",
      "refhaven.markFileReviewed",
      "refhaven.markFileUnreviewed",
      "refhaven.newComparison",
      "refhaven.nextUnreviewedFile",
      "refhaven.openAllComparisonChanges",
      "refhaven.openBrowserBranch",
      "refhaven.openBrowserCommit",
      "refhaven.openBrowserComparison",
      "refhaven.openBrowserFile",
      "refhaven.openBrowserLocalReference",
      "refhaven.openBrowserProject",
      "refhaven.openBrowserReference",
      "refhaven.openChangedFileAtRevision",
      "refhaven.openCommitParentDetails",
      "refhaven.openFile",
      "refhaven.openFileAtRevision",
      "refhaven.openFileHistoryAtRevision",
      "refhaven.openFileHistoryDiff",
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
      "refhaven.renameComparison",
      "refhaven.resetComparisonReview",
      "refhaven.revealFileInComparison",
      "refhaven.saveComparisonPatch",
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
    assert.deepEqual(
      manifest.contributes.menus["explorer/context"]?.find(
        ({ submenu }) => submenu === "refhaven.fileActions",
      ),
      {
        group: "navigation@19",
        submenu: "refhaven.fileActions",
        when: "resourceScheme == file && !explorerResourceIsFolder",
      },
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
      "refhaven.revealFileInComparison",
      "refhaven.changeFileAnnotations",
      "refhaven.stashFile",
      "refhaven.openBrowserFile",
      "refhaven.copyBrowserFileUrl",
      "refhaven.openBrowserReference",
    ]);
  });

  test("contributes single-file stash only inside the unified RefHaven submenu", () => {
    const manifest = loadManifest();

    assert.deepEqual(
      manifest.contributes.commands.find(({ command }) => command === "refhaven.stashFile"),
      {
        category: "RefHaven",
        command: "refhaven.stashFile",
        icon: "$(git-stash)",
        title: "Stash This File...",
      },
    );
    assert.deepEqual(
      manifest.contributes.menus["scm/resourceState/context"]?.filter(
        ({ command }) => command === "refhaven.stashFile",
      ),
      [],
    );
    assert.deepEqual(
      manifest.contributes.menus["refhaven.fileActions"]?.filter(
        ({ command }) => command === "refhaven.stashFile",
      ),
      [
        {
          command: "refhaven.stashFile",
          group: "4_stash@1",
          when: "resourceScheme == file || scmProvider == git",
        },
      ],
    );
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

    // Search results are shown in the Inspector, and its empty state tells the
    // reader to search, so the entry point has to be in that view's title.
    assert.ok(
      (manifest.contributes.menus["view/title"] ?? []).some(
        ({ command, when }) =>
          command === "refhaven.searchCommits" && when === "view == refhaven.inspector",
      ),
    );

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

  test("packages only compiled runtime files and trust-boundary documents", () => {
    const manifest = loadManifest();

    assert.deepEqual(manifest.files, [
      "dist/**/*.js",
      "assets/refhaven-icon-256.png",
      "LICENSE",
      "CHANGELOG.md",
      "SECURITY.md",
      "PRIVACY.md",
      "IP-PROVENANCE.md",
    ]);
    assert.equal(manifest.icon, "assets/refhaven-icon-256.png");
  });

  test("requires a trusted, filesystem-backed workspace", () => {
    const manifest = loadManifest();

    assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
    assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
  });

  test("has no runtime dependencies and exact-pins the minimal development toolchain", () => {
    const manifest = loadManifest();

    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.devDependencies.rimraf, undefined);
    assert.equal(manifest.devDependencies["@vscode/test-cli"], undefined);
    for (const [name, version] of Object.entries(manifest.devDependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/u, `${name} must use an exact version`);
    }
    for (const [name, version] of Object.entries(manifest.overrides ?? {})) {
      assert.match(version, /^\d+\.\d+\.\d+$/u, `${name} override must use an exact version`);
    }
  });

  test("declares a bounded Git command timeout", () => {
    const setting = manifestSetting(
      loadManifest(),
      extensionSettingPath(EXTENSION_SETTINGS.gitTimeoutSeconds),
    );
    assert.equal(setting.default, EXTENSION_SETTING_DEFAULTS.gitTimeoutSeconds);
    assert.equal(setting.minimum, EXTENSION_SETTING_LIMITS.gitTimeoutSeconds.minimum);
    assert.equal(setting.maximum, EXTENSION_SETTING_LIMITS.gitTimeoutSeconds.maximum);
  });

  test("keeps every runtime setting default aligned with the manifest", () => {
    const manifest = loadManifest();
    const expectedDefaults: readonly (readonly [ExtensionSetting, unknown])[] = [
      [
        EXTENSION_SETTINGS.approvedBrowserOrigins,
        EXTENSION_SETTING_DEFAULTS.approvedBrowserOrigins,
      ],
      [EXTENSION_SETTINGS.fileAnnotationsMode, EXTENSION_SETTING_DEFAULTS.fileAnnotationsMode],
      [EXTENSION_SETTINGS.gitTimeoutSeconds, EXTENSION_SETTING_DEFAULTS.gitTimeoutSeconds],
      [EXTENSION_SETTINGS.inlineBlameEnabled, EXTENSION_SETTING_DEFAULTS.inlineBlameEnabled],
      [EXTENSION_SETTINGS.lineHoverEnabled, EXTENSION_SETTING_DEFAULTS.lineHoverEnabled],
      [EXTENSION_SETTINGS.statusBarBlameEnabled, EXTENSION_SETTING_DEFAULTS.statusBarBlameEnabled],
    ];

    for (const [setting, expectedDefault] of expectedDefaults) {
      assert.deepEqual(
        manifestSetting(manifest, extensionSettingPath(setting)).default,
        expectedDefault,
      );
    }
  });

  test("keeps whole-file annotations opt-in", () => {
    const setting = manifestSetting(
      loadManifest(),
      extensionSettingPath(EXTENSION_SETTINGS.fileAnnotationsMode),
    );
    assert.equal(setting.default, EXTENSION_SETTING_DEFAULTS.fileAnnotationsMode);
  });

  test("enables rich local line hover by default", () => {
    const setting = manifestSetting(
      loadManifest(),
      extensionSettingPath(EXTENSION_SETTINGS.lineHoverEnabled),
    );
    assert.equal(setting.default, EXTENSION_SETTING_DEFAULTS.lineHoverEnabled);
  });

  test("enables zero-config GitLab links with an optional strict allowlist", () => {
    const setting = manifestSetting(
      loadManifest(),
      extensionSettingPath(EXTENSION_SETTINGS.approvedBrowserOrigins),
    );
    assert.deepEqual(setting.default, EXTENSION_SETTING_DEFAULTS.approvedBrowserOrigins);
    assert.match(setting.description ?? "", /leave empty.*local repository remotes/iu);
    assert.match(setting.description ?? "", /strict allowlist/iu);
  });
});

function manifestSetting(
  manifest: PackageManifest,
  key: string,
): {
  readonly default: unknown;
  readonly description?: string;
  readonly maximum?: number;
  readonly minimum?: number;
} {
  const setting = manifest.contributes.configuration.properties[key];
  assert.ok(setting, `Expected manifest setting ${key}`);
  return setting;
}
