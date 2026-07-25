import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import { buildRepositoryIdentities } from "../../src/infrastructure/git/repositoryDiscovery";

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
});
