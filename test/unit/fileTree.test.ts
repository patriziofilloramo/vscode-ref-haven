import assert from "node:assert/strict";

import type { FileChange } from "../../src/domain/comparisonResult";
import { buildFileTree, type FileTreeFolder, type FileTreeNode } from "../../src/ui/tree/fileTree";

function change(newPath: string): FileChange {
  return { newPath, status: "modified" };
}

function expectFolder(node: FileTreeNode | undefined): FileTreeFolder {
  assert.ok(node?.kind === "folder", "Expected a folder node");
  return node;
}

suite("buildFileTree", () => {
  test("returns leaves for root-level files", () => {
    const nodes = buildFileTree([change("README.md")]);

    assert.deepEqual(nodes, [{ file: change("README.md"), kind: "leaf", name: "README.md" }]);
  });

  test("groups files under their folders with folders listed first", () => {
    const nodes = buildFileTree([change("zzz.txt"), change("src/a.ts"), change("src/b.ts")]);

    assert.equal(nodes.length, 2);
    const folder = expectFolder(nodes[0]);
    assert.equal(folder.name, "src");
    assert.equal(folder.children.length, 2);
    assert.equal(nodes[1]?.kind, "leaf");
  });

  test("compacts single-child folder chains", () => {
    const nodes = buildFileTree([
      change("src/application/ComparisonEngine.ts"),
      change("src/application/ComparisonController.ts"),
    ]);

    assert.equal(nodes.length, 1);
    const folder = expectFolder(nodes[0]);
    assert.equal(folder.name, "src/application");
    assert.equal(folder.path, "src/application");
    assert.equal(folder.children.length, 2);
  });

  test("stops compacting where a folder has files or siblings", () => {
    const nodes = buildFileTree([
      change("src/ui/tree/provider.ts"),
      change("src/ui/format.ts"),
      change("src/extension.ts"),
    ]);

    const src = expectFolder(nodes[0]);
    assert.equal(src.name, "src");
    const ui = expectFolder(src.children[0]);
    assert.equal(ui.name, "ui");
    assert.equal(ui.path, "src/ui");
    const tree = expectFolder(ui.children[0]);
    assert.equal(tree.name, "tree");
    assert.equal(tree.children.length, 1);
  });

  test("sorts folder and file names case-insensitively and numerically", () => {
    const nodes = buildFileTree([
      change("b/x.ts"),
      change("A/x.ts"),
      change("a10.ts"),
      change("a2.ts"),
    ]);

    assert.deepEqual(
      nodes.map((node) => node.name),
      ["A", "b", "a2.ts", "a10.ts"],
    );
  });
});
