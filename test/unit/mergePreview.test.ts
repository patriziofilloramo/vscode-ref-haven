import assert from "node:assert/strict";
import Module from "node:module";

import type * as MergePreviewModule from "../../src/infrastructure/git/mergePreview";

const BASE_SHA = "1".repeat(40);
const TARGET_SHA = "2".repeat(40);

type PreviewMerge = typeof MergePreviewModule.previewMerge;
type PreviewRunner = NonNullable<Parameters<PreviewMerge>[4]>;

let parseConflictedPaths: typeof MergePreviewModule.parseConflictedPaths;
let previewMerge: PreviewMerge;
let resetMergePreviewSupportCache: typeof MergePreviewModule.resetMergePreviewSupportCache;

suite("merge preview", () => {
  suiteSetup(async () => {
    // GitProcess depends on VS Code configuration, but these tests inject the
    // process runner and never consult it. Supply only a load-time placeholder
    // so this policy logic remains runnable in the plain Node unit-test host.
    const loader = Module as unknown as {
      _load: (request: string, parent: NodeJS.Module | null, isMain: boolean) => unknown;
    };
    const originalLoad = loader._load;
    loader._load = (request, parent, isMain): unknown =>
      request === "vscode" ? {} : originalLoad(request, parent, isMain);
    try {
      const loaded = await import("../../src/infrastructure/git/mergePreview.js");
      ({ parseConflictedPaths, previewMerge, resetMergePreviewSupportCache } = loaded);
    } finally {
      loader._load = originalLoad;
    }
  });

  setup(() => resetMergePreviewSupportCache());

  test("fails closed before merge-tree when an external merge driver is configured", async () => {
    const calls: Parameters<PreviewRunner>[] = [];
    const runner: PreviewRunner = (...parameters) => {
      calls.push(parameters);
      return Promise.resolve({ exitCode: 0, stdout: "merge.audit.driver\n" });
    };

    assert.deepEqual(await previewMerge("/repository", BASE_SHA, TARGET_SHA, undefined, runner), {
      kind: "unavailable",
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.[1], [
      "config",
      "--includes",
      "--name-only",
      "--get-regexp",
      "^merge\\..*\\.driver$",
    ]);
  });

  test("fails closed when the external-driver config probe cannot complete", async () => {
    let calls = 0;
    const runner: PreviewRunner = () => {
      calls += 1;
      return Promise.reject(new Error("config unavailable"));
    };

    assert.deepEqual(await previewMerge("/repository", BASE_SHA, TARGET_SHA, undefined, runner), {
      kind: "unavailable",
    });
    assert.equal(calls, 1);
  });

  test("runs merge-tree with renormalization disabled after a clean config probe", async () => {
    const calls: Parameters<PreviewRunner>[] = [];
    const runner: PreviewRunner = (...parameters) => {
      calls.push(parameters);
      return Promise.resolve(
        calls.length === 1
          ? { exitCode: 1, stdout: "" }
          : { exitCode: 0, stdout: `${"3".repeat(40)}\0` },
      );
    };

    assert.deepEqual(await previewMerge("/repository", BASE_SHA, TARGET_SHA, undefined, runner), {
      kind: "clean",
    });
    assert.deepEqual(calls[1]?.[1], [
      "-c",
      "merge.renormalize=false",
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      "-z",
      BASE_SHA,
      TARGET_SHA,
    ]);
  });

  test("returns unique conflicted paths from NUL-delimited merge-tree output", () => {
    assert.deepEqual(parseConflictedPaths(`${"3".repeat(40)}\0src/a.ts\0src/b.ts\0src/a.ts\0`), [
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("rejects traversal while accepting host-incompatible tree paths", async () => {
    const invalidOutput = `${"3".repeat(40)}\0../outside.ts\0`;
    assert.throws(() => parseConflictedPaths(invalidOutput), /invalid merge-conflict path/u);
    for (const path of ["aux.c", "safe.ts:alternate-stream", "trailing.", "trailing "]) {
      assert.deepEqual(parseConflictedPaths(`${"3".repeat(40)}\0${path}\0`), [path]);
    }

    let calls = 0;
    const runner: PreviewRunner = () => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? { exitCode: 1, stdout: "" } : { exitCode: 1, stdout: invalidOutput },
      );
    };
    assert.deepEqual(await previewMerge("/repository", BASE_SHA, TARGET_SHA, undefined, runner), {
      kind: "unavailable",
    });
  });
});
