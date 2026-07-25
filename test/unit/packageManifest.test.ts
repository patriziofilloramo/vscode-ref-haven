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
    readonly views: {
      readonly scm: readonly { readonly id: string; readonly name: string }[];
    };
  };
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
      "branchCompare.applyStash",
      "branchCompare.closeComparison",
      "branchCompare.compareCurrentBranch",
      "branchCompare.copyCommitMessage",
      "branchCompare.copyCommitSha",
      "branchCompare.copyComparisonSummary",
      "branchCompare.copyFilePath",
      "branchCompare.copyRelativeFilePath",
      "branchCompare.copyStashMessage",
      "branchCompare.dropStash",
      "branchCompare.newComparison",
      "branchCompare.openFile",
      "branchCompare.pinComparison",
      "branchCompare.popStash",
      "branchCompare.refreshAll",
      "branchCompare.refreshComparison",
      "branchCompare.refreshStashes",
      "branchCompare.stashAllChanges",
      "branchCompare.swapComparison",
      "branchCompare.unpinComparison",
      "branchCompare.viewFilesAsList",
      "branchCompare.viewFilesAsTree",
    ]);
  });

  test("packages only compiled runtime files", () => {
    const manifest = loadManifest();

    assert.deepEqual(manifest.files, ["dist/**"]);
  });
});
