import assert from "node:assert/strict";

import {
  hasOtherBlameExtension,
  lineIntelligenceMode,
  lineIntelligenceSettings,
  type InstalledExtensionManifest,
} from "../../src/domain/lineIntelligence";

function manifest(overrides: Partial<InstalledExtensionManifest> = {}): InstalledExtensionManifest {
  return {
    commandIds: [],
    commandTitles: [],
    id: "vendor.extension",
    settingKeys: [],
    ...overrides,
  };
}

suite("line intelligence", () => {
  test("maps each mode to a coherent set of the three per-line surfaces", () => {
    assert.deepEqual(lineIntelligenceSettings("full"), {
      inlineBlame: true,
      lineHover: true,
      statusBar: true,
    });
    // Hover survives coexistence: two hovers stack, two decorations collide.
    assert.deepEqual(lineIntelligenceSettings("hoverOnly"), {
      inlineBlame: false,
      lineHover: true,
      statusBar: false,
    });
    assert.deepEqual(lineIntelligenceSettings("off"), {
      inlineBlame: false,
      lineHover: false,
      statusBar: false,
    });
  });

  test("round-trips a mode through the settings it produces", () => {
    for (const mode of ["full", "hoverOnly", "off"] as const) {
      assert.equal(lineIntelligenceMode(lineIntelligenceSettings(mode)), mode);
    }
    // Keeping the line text while switching the hover off is a documented way
    // to coexist with another extension. No mode names it, and claiming one
    // would report untouched defaults to someone who has already tuned them.
    assert.equal(
      lineIntelligenceMode({ inlineBlame: true, lineHover: false, statusBar: true }),
      null,
    );
    assert.equal(
      lineIntelligenceMode({ inlineBlame: true, lineHover: false, statusBar: false }),
      null,
    );
  });

  test("detects a blame surface from what an extension declares, not from who published it", () => {
    const own = "patriziofilloramo.refhaven";

    assert.equal(
      hasOtherBlameExtension([manifest({ commandIds: ["vendor.toggleBlame"] })], own),
      true,
    );
    assert.equal(
      hasOtherBlameExtension([manifest({ commandTitles: ["Toggle File Blame"] })], own),
      true,
    );
    assert.equal(
      hasOtherBlameExtension([manifest({ settingKeys: ["vendor.blame.format"] })], own),
      true,
    );
    assert.equal(
      hasOtherBlameExtension([manifest({ commandIds: ["vendor.openChanges"] })], own),
      false,
    );
  });

  test("never reports itself, whatever case the host uses for the id", () => {
    const own = "patriziofilloramo.refhaven";
    const ours = manifest({
      commandIds: ["refhaven.toggleInlineBlame"],
      id: "PatrizioFilloramo.RefHaven",
      settingKeys: ["refhaven.inlineBlame.enabled"],
    });

    assert.equal(hasOtherBlameExtension([ours], own), false);
    // ...but a genuine second extension alongside it still counts.
    assert.equal(
      hasOtherBlameExtension([ours, manifest({ settingKeys: ["other.blame.enabled"] })], own),
      true,
    );
  });

  test("does not match blame as a substring of an unrelated word", () => {
    assert.equal(
      hasOtherBlameExtension(
        [manifest({ commandTitles: ["Blameless postmortem", "unblamed"] })],
        "own.id",
      ),
      false,
    );
  });
});
