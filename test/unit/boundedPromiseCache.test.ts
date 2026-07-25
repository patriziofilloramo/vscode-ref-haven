import assert from "node:assert/strict";

import { BoundedPromiseCache } from "../../src/ui/documents/BoundedPromiseCache";

suite("BoundedPromiseCache", () => {
  test("evicts least-recently-used entries above the count limit", async () => {
    const cache = new BoundedPromiseCache<string>(2, 100, (value) => value.length);
    let firstLoads = 0;
    const loadFirst = (): Promise<string> => {
      firstLoads += 1;
      return Promise.resolve("first");
    };

    await cache.getOrCreate("first", loadFirst);
    await cache.getOrCreate("second", () => Promise.resolve("second"));
    await cache.getOrCreate("third", () => Promise.resolve("third"));
    await cache.getOrCreate("first", loadFirst);
    assert.equal(firstLoads, 2);
  });

  test("does not retain oversized or rejected entries", async () => {
    const cache = new BoundedPromiseCache<string>(4, 3, (value) => value.length);
    let oversizedLoads = 0;
    const loadOversized = (): Promise<string> => {
      oversizedLoads += 1;
      return Promise.resolve("oversized");
    };
    await cache.getOrCreate("large", loadOversized);
    await cache.getOrCreate("large", loadOversized);
    assert.equal(oversizedLoads, 2);

    let failedLoads = 0;
    const fail = (): Promise<string> => {
      failedLoads += 1;
      return Promise.reject(new Error("failure"));
    };
    await assert.rejects(cache.getOrCreate("failure", fail));
    await assert.rejects(cache.getOrCreate("failure", fail));
    assert.equal(failedLoads, 2);

    await assert.rejects(
      cache.getOrCreate("synchronous-failure", () => {
        throw new Error("synchronous failure");
      }),
    );
  });
});
