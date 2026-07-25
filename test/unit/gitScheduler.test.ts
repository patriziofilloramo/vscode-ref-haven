import assert from "node:assert/strict";

import { GitScheduler } from "../../src/infrastructure/git/GitScheduler";

suite("GitScheduler", () => {
  test("enforces global and per-repository concurrency limits", async () => {
    const scheduler = new GitScheduler(2, 1);
    const first = deferred<undefined>();
    const second = deferred<undefined>();
    const started: string[] = [];

    const tasks = [
      scheduler.run("repo-a", async () => {
        started.push("a1");
        await first.promise;
      }),
      scheduler.run("repo-a", () => {
        started.push("a2");
        return Promise.resolve();
      }),
      scheduler.run("repo-b", async () => {
        started.push("b1");
        await second.promise;
      }),
    ];

    await nextTurn();
    assert.deepEqual(started, ["a1", "b1"]);
    first.resolve(undefined);
    await nextTurn();
    assert.deepEqual(started, ["a1", "b1", "a2"]);
    second.resolve(undefined);
    await Promise.all(tasks);
  });

  test("removes an aborted operation from the queue", async () => {
    const scheduler = new GitScheduler(1, 1);
    const blocker = deferred<undefined>();
    const running = scheduler.run("repo", () => blocker.promise);
    const abortController = new AbortController();
    const queued = scheduler.run("repo", () => Promise.resolve(), abortController.signal);

    abortController.abort();
    await assert.rejects(queued, { name: "AbortError" });
    blocker.resolve(undefined);
    await running;
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) throw new Error("Deferred promise was not initialized.");
  return { promise, resolve: resolvePromise };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
