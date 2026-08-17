import assert from "node:assert/strict";

import {
  buildLocalOnlyGitArguments,
  buildLocalOnlyGitEnvironment,
  isFilterInertGitInvocation,
  parseConfiguredFilterDrivers,
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
      "--literal-pathspecs",
      "-c",
      "protocol.allow=never",
      "-c",
      "core.fsmonitor=false",
      "show",
      "abc:file.txt",
    ]);
  });

  test("neutralizes every command form of each configured content filter", () => {
    const drivers = parseConfiguredFilterDrivers(
      [
        "filter.lfs.clean",
        "filter.lfs.smudge",
        "filter.audit.process",
        "filter.audit.required",
        "filter.audit.unrelated",
      ].join("\0") + "\0",
    );

    assert.deepEqual(drivers, ["lfs", "audit"]);
    assert.deepEqual(buildLocalOnlyGitArguments(["status"], drivers), [
      "--literal-pathspecs",
      "-c",
      "protocol.allow=never",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "filter.lfs.clean=",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
      "-c",
      "filter.audit.clean=",
      "-c",
      "filter.audit.smudge=",
      "-c",
      "filter.audit.process=",
      "-c",
      "filter.audit.required=false",
      "status",
    ]);
  });

  test("treats exactly the ref, config, attribute, and object plumbing as filter-inert", () => {
    for (const inert of [
      ["check-attr", "--stdin", "-z", "filter"],
      ["commit-tree", "abc123", "-p", "def456"],
      ["config", "--bool", "core.sparseCheckout"],
      ["for-each-ref", "--format=%(refname)"],
      ["ls-tree", "-z", "--full-tree", "HEAD"],
      ["rev-parse", "--verify", "HEAD^{commit}"],
      ["symbolic-ref", "--short", "HEAD"],
      ["update-ref", "--stdin", "--create-reflog"],
      ["var", "GIT_AUTHOR_IDENT"],
      ["write-tree"],
    ]) {
      assert.equal(isFilterInertGitInvocation(inert), true, inert.join(" "));
    }

    for (const contentConverting of [
      ["add", "--", "file.txt"],
      ["blame", "--porcelain", "file.txt"],
      ["cat-file", "--filters", "abc123"],
      ["checkout", "--", "file.txt"],
      ["diff", "--no-ext-diff"],
      ["hash-object", "-w", "--", "file.txt"],
      ["log", "--format=%H"],
      ["ls-files", "--eol", "-z"],
      ["ls-files", "--stage", "-z", "--", "file.txt"],
      ["merge-tree", "--write-tree"],
      ["read-tree", "HEAD"],
      ["restore", "--", "file.txt"],
      ["show", "abc123:file.txt"],
      ["stash", "list"],
      ["status", "--porcelain=v2"],
      ["update-index", "--force-remove"],
    ]) {
      assert.equal(
        isFilterInertGitInvocation(contentConverting),
        false,
        contentConverting.join(" "),
      );
    }
  });

  test("locates the subcommand only behind RefHaven's own leading flags", () => {
    assert.equal(
      isFilterInertGitInvocation(["-c", "core.hooksPath=/tmp/disabled", "update-ref", "--stdin"]),
      true,
    );
    assert.equal(
      isFilterInertGitInvocation(["--no-literal-pathspecs", "ls-tree", "-z", "HEAD"]),
      true,
    );
    assert.equal(
      isFilterInertGitInvocation(["-c", "core.hooksPath=/tmp/disabled", "commit-tree", "abc123"]),
      true,
    );
  });

  test("fails closed when the subcommand cannot be identified", () => {
    assert.equal(isFilterInertGitInvocation([]), false);
    assert.equal(isFilterInertGitInvocation(["-c"]), false);
    assert.equal(isFilterInertGitInvocation(["-c", "key=value"]), false);
    assert.equal(isFilterInertGitInvocation([""]), false);
    assert.equal(isFilterInertGitInvocation(["-C", "/repo", "rev-parse"]), false);
    assert.equal(isFilterInertGitInvocation(["--exec-path=/elsewhere", "rev-parse"]), false);
    assert.equal(isFilterInertGitInvocation(["--git-dir=/elsewhere/.git", "config"]), false);
  });

  test("fails closed on malformed, unsafe, or excessive filter configuration", () => {
    assert.throws(() => parseConfiguredFilterDrivers("filter.audit.clean"), /stopped before/u);
    assert.throws(() => parseConfiguredFilterDrivers("filter.bad name.clean\0"), /stopped before/u);
    assert.throws(
      () =>
        parseConfiguredFilterDrivers(
          Array.from({ length: 65 }, (_, index) => `filter.driver-${index.toString()}.clean`).join(
            "\0",
          ) + "\0",
        ),
      /stopped before/u,
    );
  });
});
