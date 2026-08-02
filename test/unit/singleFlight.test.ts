import assert from "node:assert/strict";

import { SingleFlight, type SingleFlightReport } from "../../src/infrastructure/git/singleFlight";

suite("SingleFlight", () => {
  test("shares one in-flight operation among concurrent callers of a key", async () => {
    const flight = new SingleFlight<string>();
    let runs = 0;
    let release: (value: string) => void = () => undefined;
    const operation = (): Promise<string> => {
      runs += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };

    const first = flight.run("repo", operation);
    const second = flight.run("repo", operation);
    await Promise.resolve();
    release("configured");

    assert.deepEqual(await Promise.all([first, second]), ["configured", "configured"]);
    assert.equal(runs, 1);
  });

  test("runs distinct keys and sequential callers independently", async () => {
    const flight = new SingleFlight<number>();
    let runs = 0;
    const operation = (): Promise<number> => {
      runs += 1;
      return Promise.resolve(runs);
    };

    assert.equal(await flight.run("left", operation), 1);
    assert.equal(await flight.run("left", operation), 2);
    const [leftAgain, right] = await Promise.all([
      flight.run("left", operation),
      flight.run("right", operation),
    ]);
    assert.notEqual(leftAgain, right);
    assert.equal(runs, 4);
  });

  test("propagates one rejection to every sharer, then clears the entry", async () => {
    const flight = new SingleFlight<string>();
    let runs = 0;
    let fail: (error: Error) => void = () => undefined;
    const failing = (): Promise<string> => {
      runs += 1;
      return new Promise<string>((_resolve, reject) => {
        fail = reject;
      });
    };

    const first = flight.run("repo", failing);
    const second = flight.run("repo", failing);
    await Promise.resolve();
    fail(new Error("probe failed"));

    await assert.rejects(first, /probe failed/u);
    await assert.rejects(second, /probe failed/u);
    assert.equal(await flight.run("repo", () => Promise.resolve("recovered")), "recovered");
    assert.equal(runs, 1);
  });

  test("reports duration and how many callers shared the settled flight", async () => {
    let nowMs = 100;
    const flight = new SingleFlight<string>(() => nowMs);
    const reports: SingleFlightReport[] = [];
    let release: (value: string) => void = () => undefined;
    const operation = (): Promise<string> =>
      new Promise<string>((resolve) => {
        release = resolve;
      });
    const observe = (report: SingleFlightReport): void => {
      reports.push(report);
    };

    const first = flight.run("repo", operation, observe);
    const second = flight.run("repo", operation, observe);
    await Promise.resolve();
    nowMs = 180;
    release("done");
    await Promise.all([first, second]);

    assert.deepEqual(reports, [{ durationMs: 80, sharedCallers: 2 }]);
  });
});
