import { readdir } from "node:fs/promises";
import { join } from "node:path";

import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({ timeout: 20_000, ui: "tdd" });
  const testDirectory = __dirname;
  const files = (await readdir(testDirectory)).filter((name) => name.endsWith(".test.js")).sort();

  for (const file of files) mocha.addFile(join(testDirectory, file));

  await new Promise<void>((resolveRun, rejectRun) => {
    mocha.run((failures) => {
      if (failures === 0) resolveRun();
      else rejectRun(new Error(`${failures.toString()} Extension Host test(s) failed.`));
    });
  });
}
