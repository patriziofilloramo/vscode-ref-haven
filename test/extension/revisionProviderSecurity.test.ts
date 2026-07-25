import assert from "node:assert/strict";
import { resolve } from "node:path";

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

  test("exposes revision identity only for URIs it signed itself", () => {
    const provider = new GitRevisionContentProvider();
    const foreignProvider = new GitRevisionContentProvider();
    try {
      const repositoryRoot = resolve("fixture");
      const sha = "a".repeat(40);
      const uri = provider.createRevisionUri(repositoryRoot, sha, "src/safe.txt");

      assert.deepEqual(provider.parseVerifiedRevisionUri(uri), {
        filePath: "src/safe.txt",
        repositoryRoot,
        sha,
      });

      const tampered = uri.with({ query: `${uri.query.slice(0, -1)}x` });
      assert.equal(provider.parseVerifiedRevisionUri(tampered), null);
      assert.equal(foreignProvider.parseVerifiedRevisionUri(uri), null);
      assert.equal(
        provider.parseVerifiedRevisionUri(provider.createEmptyUri("src/safe.txt")),
        null,
      );
      assert.equal(provider.parseVerifiedRevisionUri(uri.with({ scheme: "file" })), null);
    } finally {
      provider.dispose();
      foreignProvider.dispose();
    }
  });
});
