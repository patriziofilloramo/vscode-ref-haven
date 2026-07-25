import assert from "node:assert/strict";

import {
  buildLocalOnlyGitArguments,
  buildLocalOnlyGitEnvironment,
} from "../../src/infrastructure/git/gitProcessPolicy";

suite("local-only Git process policy", () => {
  test("blocks transports, lazy fetch, prompts, pagers, and tracing", () => {
    const environment = buildLocalOnlyGitEnvironment({
      GIT_ALLOW_PROTOCOL: "https:ssh",
      GIT_NO_LAZY_FETCH: "0",
      GIT_PAGER: "less",
      GIT_TERMINAL_PROMPT: "1",
      GIT_TRACE: "1",
      PATH: "trusted-path",
    });

    assert.equal(environment.PATH, "trusted-path");
    assert.equal(environment.GIT_ALLOW_PROTOCOL, "");
    assert.equal(environment.GIT_NO_LAZY_FETCH, "1");
    assert.equal(environment.GIT_NO_REPLACE_OBJECTS, "1");
    assert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
    assert.equal(environment.GIT_PAGER, "cat");
    assert.equal(environment.PAGER, "cat");
    assert.equal(environment.GIT_TRACE, "0");
    assert.equal(environment.GIT_TRACE_PACKET, "0");
    assert.equal(environment.GIT_TRACE_CURL, "0");
    assert.equal(environment.GIT_TRACE2_EVENT, "0");
    assert.equal(environment.GIT_TRACE_PERFORMANCE, "0");
    assert.equal(environment.GIT_TRACE_SETUP, "0");
  });

  test("removes inherited repository redirection and injected configuration", () => {
    const environment = buildLocalOnlyGitEnvironment({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_GLOBAL: "/redirected/global-config",
      GIT_CONFIG_KEY_0: "protocol.https.allow",
      GIT_CONFIG_PARAMETERS: "'protocol.allow'='always'",
      GIT_CONFIG_VALUE_0: "always",
      GIT_DIR: "/another/repository/.git",
      GIT_EXEC_PATH: "/untrusted/helpers",
      GIT_EXTERNAL_DIFF: "upload-diff",
      GIT_SSH_COMMAND: "custom-ssh",
      GIT_WORK_TREE: "/another/repository",
    });

    for (const name of [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_VALUE_0",
      "GIT_DIR",
      "GIT_EXEC_PATH",
      "GIT_EXTERNAL_DIFF",
      "GIT_SSH_COMMAND",
      "GIT_WORK_TREE",
    ]) {
      assert.equal(environment[name], undefined, `${name} must not reach Git`);
    }
  });

  test("places command-scoped restrictions before the Git subcommand", () => {
    assert.deepEqual(buildLocalOnlyGitArguments(["show", "abc:file.txt"]), [
      "-c",
      "protocol.allow=never",
      "-c",
      "core.fsmonitor=false",
      "show",
      "abc:file.txt",
    ]);
  });
});
