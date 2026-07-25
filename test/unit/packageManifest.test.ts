import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface CommandContribution {
  readonly command: string;
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
    readonly views: {
      readonly scm: readonly { readonly id: string; readonly name: string }[];
    };
  };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly files: readonly string[];
}

function loadManifest(): PackageManifest {
  const manifestPath = resolve(__dirname, "../../../package.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
}

suite("extension manifest", () => {
  test("contributes the Branch Comparisons and Stashes views to Source Control", () => {
    const manifest = loadManifest();

    assert.deepEqual(manifest.contributes.views.scm, [
      { id: "branchCompare.comparisons", name: "Branch Comparisons" },
      { id: "branchCompare.stashes", name: "Stashes" },
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
      "branchCompare.closeComparison",
      "branchCompare.compareCurrentBranch",
      "branchCompare.copyCommitMessage",
      "branchCompare.copyCommitSha",
      "branchCompare.copyComparisonSummary",
      "branchCompare.copyFilePath",
      "branchCompare.copyRelativeFilePath",
      "branchCompare.copyStashMessage",
      "branchCompare.newComparison",
      "branchCompare.openFile",
      "branchCompare.openFileAtRevision",
      "branchCompare.pinComparison",
      "branchCompare.refreshAll",
      "branchCompare.refreshComparison",
      "branchCompare.refreshStashes",
      "branchCompare.showLineBlameActions",
      "branchCompare.swapComparison",
      "branchCompare.toggleInlineBlame",
      "branchCompare.unpinComparison",
      "branchCompare.viewFilesAsList",
      "branchCompare.viewFilesAsTree",
    ]);
  });

  test("packages only compiled runtime files", () => {
    const manifest = loadManifest();

    assert.deepEqual(manifest.files, ["dist/**", "SECURITY.md"]);
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
    const setting = manifestSetting(loadManifest(), "branchCompare.git.timeoutSeconds");
    assert.equal(setting.default, 30);
    assert.equal(setting.minimum, 1);
    assert.equal(setting.maximum, 300);
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
