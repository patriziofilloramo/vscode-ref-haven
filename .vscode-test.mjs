import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: ".test-out/test/extension/**/*.test.js",
  launchArgs: ["--disable-extensions"],
  mocha: {
    timeout: 20_000,
    ui: "tdd",
  },
  version: "stable",
  workspaceFolder: "test/fixtures/workspace",
});
