import assert from "node:assert/strict";

import {
  buildGitLabUrl,
  inferGitLabProjects,
  matchApprovedGitLabProjects,
  parseApprovedGitLabOrigins,
  resolveGitLabProjects,
} from "../../src/domain/gitLab";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

suite("GitLab browser links", () => {
  test("accepts exact HTTP(S) origins and rejects paths, credentials, and other protocols", () => {
    assert.deepEqual(
      parseApprovedGitLabOrigins([
        "https://gitlab.example.test",
        "https://gitlab.example.test/",
        "http://gitlab.example.test:8080",
      ]),
      [
        { hostname: "gitlab.example.test", origin: "https://gitlab.example.test" },
        { hostname: "gitlab.example.test", origin: "http://gitlab.example.test:8080" },
      ],
    );
    for (const value of [
      "ssh://gitlab.example.test",
      "https://user@gitlab.example.test",
      "https://gitlab.example.test/group",
      "https://gitlab.example.test?query=1",
      "not a URL",
    ]) {
      assert.throws(() => parseApprovedGitLabOrigins([value]), /origin|invalid/iu);
    }
  });

  test("bounds approved-origin configuration independently of the manifest", () => {
    assert.throws(
      () => parseApprovedGitLabOrigins(Array.from({ length: 21 }, () => "https://gitlab.test")),
      /at most 20/iu,
    );
    assert.throws(
      () => parseApprovedGitLabOrigins([`https://${"a".repeat(2_048)}.test`]),
      /at most 2048/iu,
    );
    assert.throws(() => parseApprovedGitLabOrigins([42]), /must be a string/iu);
  });

  test("matches HTTP remotes by exact origin and SSH remotes by approved hostname", () => {
    const origins = parseApprovedGitLabOrigins([
      "https://gitlab.example.test",
      "https://gitlab.example.test:8443",
    ]);
    const projects = matchApprovedGitLabProjects(
      [
        { name: "backup", url: "https://user:token@gitlab.example.test/group/project.git" },
        { name: "origin", url: "git@gitlab.example.test:group/project.git" },
        { name: "ssh-url", url: "ssh://git@gitlab.example.test:2222/group/other.git" },
        { name: "wrong-port", url: "https://gitlab.example.test:9443/group/rejected.git" },
        { name: "file", url: "C:/repositories/local" },
      ],
      origins,
    );

    assert.deepEqual(
      projects.map(({ browserOrigin, projectPath, remoteName }) => ({
        origin: browserOrigin.origin,
        projectPath,
        remoteName,
      })),
      [
        {
          origin: "https://gitlab.example.test",
          projectPath: "group/project",
          remoteName: "origin",
        },
        {
          origin: "https://gitlab.example.test:8443",
          projectPath: "group/project",
          remoteName: "origin",
        },
        {
          origin: "https://gitlab.example.test",
          projectPath: "group/other",
          remoteName: "ssh-url",
        },
        {
          origin: "https://gitlab.example.test:8443",
          projectPath: "group/other",
          remoteName: "ssh-url",
        },
      ],
    );
  });

  test("infers zero-config browser origins from validated local remotes", () => {
    const projects = inferGitLabProjects([
      { name: "backup", url: "https://user:token@gitlab.example.test/group/project.git" },
      { name: "origin", url: "git@gitlab.example.test:group/project.git" },
      { name: "authenticated", url: "https://user:token@auth.example.test/group/auth.git" },
      { name: "custom-http", url: "http://gitlab.internal.test:8080/team/service.git" },
      { name: "ssh-port", url: "ssh://git@gitlab.ssh.test:2222/group/other.git" },
      { name: "local", url: "C:/repositories/local" },
      { name: "query", url: "https://gitlab.example.test/group/rejected.git?token=secret" },
      { name: "invalid-ipv6", url: "git@[not-ipv6]:group/rejected.git" },
    ]);

    assert.deepEqual(
      projects.map(({ browserOrigin, projectPath, remoteName }) => ({
        origin: browserOrigin.origin,
        projectPath,
        remoteName,
      })),
      [
        {
          origin: "https://gitlab.example.test",
          projectPath: "group/project",
          remoteName: "origin",
        },
        {
          origin: "https://auth.example.test",
          projectPath: "group/auth",
          remoteName: "authenticated",
        },
        {
          origin: "https://gitlab.ssh.test",
          projectPath: "group/other",
          remoteName: "ssh-port",
        },
        {
          origin: "http://gitlab.internal.test:8080",
          projectPath: "team/service",
          remoteName: "custom-http",
        },
      ],
    );
  });

  test("activates strict allowlist matching as soon as an origin is configured", () => {
    const remotes = [{ name: "origin", url: "git@gitlab.example.test:group/project.git" }] as const;

    assert.equal(resolveGitLabProjects(remotes, []).length, 1);
    assert.deepEqual(
      resolveGitLabProjects(
        remotes,
        parseApprovedGitLabOrigins(["https://different.example.test"]),
      ),
      [],
    );
    assert.equal(
      resolveGitLabProjects(remotes, parseApprovedGitLabOrigins(["https://gitlab.example.test"]))[0]
        ?.browserOrigin.origin,
      "https://gitlab.example.test",
    );
  });

  test("rejects unsafe or malformed remote project paths", () => {
    const origins = parseApprovedGitLabOrigins(["https://gitlab.example.test"]);
    const projects = matchApprovedGitLabProjects(
      [
        { name: "root", url: "git@gitlab.example.test:project.git" },
        { name: "encoded-slash", url: "https://gitlab.example.test/group%2Fescape/project.git" },
        { name: "query", url: "https://gitlab.example.test/group/project.git?token=secret" },
        { name: "other", url: "git@other.example.test:group/project.git" },
      ],
      origins,
    );
    assert.deepEqual(projects, []);
  });

  test("builds immutable project, commit, tree, compare, file, issue, and MR URLs", () => {
    const [browserOrigin] = parseApprovedGitLabOrigins(["https://gitlab.example.test:8443"]);
    assert.ok(browserOrigin);
    const project = {
      browserOrigin,
      projectPath: "group/sub group/project",
      remoteName: "origin",
    };
    assert.equal(
      buildGitLabUrl(project, { kind: "project" }),
      "https://gitlab.example.test:8443/group/sub%20group/project",
    );
    assert.equal(
      buildGitLabUrl(project, { kind: "commit", sha: SHA_A }),
      `https://gitlab.example.test:8443/group/sub%20group/project/-/commit/${SHA_A}`,
    );
    assert.equal(
      buildGitLabUrl(project, { kind: "tree", sha: SHA_A }),
      `https://gitlab.example.test:8443/group/sub%20group/project/-/tree/${SHA_A}`,
    );
    assert.equal(
      buildGitLabUrl(project, { baseSha: SHA_A, kind: "compare", targetSha: SHA_B }),
      `https://gitlab.example.test:8443/group/sub%20group/project/-/compare/${SHA_A}...${SHA_B}`,
    );
    assert.equal(
      buildGitLabUrl(project, {
        endLine: 12,
        filePath: "src/space name.ts",
        kind: "file",
        sha: SHA_A,
        startLine: 10,
      }),
      `https://gitlab.example.test:8443/group/sub%20group/project/-/blob/${SHA_A}/src/space%20name.ts#L10-12`,
    );
    assert.equal(
      buildGitLabUrl(project, { kind: "issue", number: 42 }),
      "https://gitlab.example.test:8443/group/sub%20group/project/-/issues/42",
    );
    assert.equal(
      buildGitLabUrl(project, { kind: "mergeRequest", number: 7 }),
      "https://gitlab.example.test:8443/group/sub%20group/project/-/merge_requests/7",
    );
  });

  test("fails closed for invalid targets and origin changes", () => {
    const [browserOrigin] = parseApprovedGitLabOrigins(["https://gitlab.example.test"]);
    assert.ok(browserOrigin);
    const project = { browserOrigin, projectPath: "group/project", remoteName: "origin" };
    assert.throws(() => buildGitLabUrl(project, { kind: "commit", sha: "HEAD" }), /revision/iu);
    assert.throws(
      () =>
        buildGitLabUrl(project, {
          filePath: "../secret",
          kind: "file",
          sha: SHA_A,
        }),
      /path/iu,
    );
    assert.throws(() => buildGitLabUrl(project, { kind: "issue", number: 0 }), /number/iu);
    assert.throws(
      () =>
        buildGitLabUrl(
          { ...project, projectPath: "group/project/../../outside" },
          { kind: "project" },
        ),
      /allowed origin|invalid/iu,
    );
  });
});
