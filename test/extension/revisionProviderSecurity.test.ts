import assert from "node:assert/strict";

import { GitRevisionContentProvider } from "../../src/ui/documents/GitRevisionContentProvider";

suite("revision document security", () => {
  test("accepts signed URIs and rejects tampering and traversal", async () => {
    const provider = new GitRevisionContentProvider();
    try {
      const uri = provider.createEmptyUri("src/safe.txt");
      assert.equal(await provider.provideTextDocumentContent(uri), "");

      const tampered = uri.with({ query: `${uri.query.slice(0, -1)}x` });
      await assert.rejects(provider.provideTextDocumentContent(tampered), /unknown/i);
      assert.throws(() => provider.createEmptyUri("..\\outside.txt"), /invalid/i);
    } finally {
      provider.dispose();
    }
  });
});
