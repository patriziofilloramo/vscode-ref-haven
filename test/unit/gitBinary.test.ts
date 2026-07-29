import assert from "node:assert/strict";

import {
  selectGitBinaryPath,
  type GitBinaryEnvironment,
} from "../../src/infrastructure/git/gitBinary";

function posixEnv(
  present: Iterable<string>,
  overrides: Partial<GitBinaryEnvironment> = {},
): GitBinaryEnvironment {
  const files = new Set(present);
  return {
    isExecutableFile: (candidate) => files.has(candidate),
    pathExtValue: undefined,
    pathValue: "/usr/local/bin:/usr/bin:/bin",
    platform: "linux",
    ...overrides,
  };
}

function windowsEnv(
  present: Iterable<string>,
  overrides: Partial<GitBinaryEnvironment> = {},
): GitBinaryEnvironment {
  const files = new Set(present);
  return {
    isExecutableFile: (candidate) => files.has(candidate),
    pathExtValue: ".COM;.EXE;.BAT;.CMD",
    pathValue: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd",
    platform: "win32",
    ...overrides,
  };
}

suite("git binary resolution", () => {
  test("prefers a configured absolute path that exists", () => {
    const environment = posixEnv(["/opt/git/bin/git", "/usr/bin/git"]);
    assert.equal(selectGitBinaryPath(["/opt/git/bin/git"], environment), "/opt/git/bin/git");
  });

  test("ignores configured paths that are relative or missing, then probes PATH", () => {
    const environment = posixEnv(["/usr/bin/git"]);
    assert.equal(selectGitBinaryPath(["git", "/nowhere/git"], environment), "/usr/bin/git");
  });

  test("resolves the first absolute PATH directory that contains git", () => {
    const environment = posixEnv(["/bin/git", "/usr/bin/git"]);
    assert.equal(selectGitBinaryPath([], environment), "/usr/bin/git");
  });

  test("never resolves from an empty or relative PATH entry", () => {
    const environment = posixEnv(["git", "bin/git"], {
      pathValue: ":.:bin:/opt/bin",
      isExecutableFile: (candidate) => candidate === "git" || candidate === "bin/git",
    });
    // "git" (empty entry → cwd) and "bin/git" (relative entry) must be rejected.
    assert.throws(() => selectGitBinaryPath([], environment), /absolute executable path/u);
  });

  test("probes Windows executable extensions including git.exe", () => {
    const environment = windowsEnv(["C:\\Program Files\\Git\\cmd\\git.exe"]);
    assert.equal(selectGitBinaryPath([], environment), "C:\\Program Files\\Git\\cmd\\git.exe");
  });

  test("fails closed instead of returning a bare executable name", () => {
    assert.throws(() => selectGitBinaryPath([], posixEnv([])), /absolute executable path/u);
    assert.throws(
      () => selectGitBinaryPath(["relative/git"], posixEnv([])),
      /absolute executable path/u,
    );
  });

  test("treats an absent PATH as unresolved", () => {
    const environment = posixEnv([], { pathValue: undefined });
    assert.throws(() => selectGitBinaryPath([], environment), /absolute executable path/u);
  });
});
