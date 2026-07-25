import assert from "node:assert/strict";

import {
  buildApprovedGitLabUrl,
  matchApprovedGitLabProjects,
  parseApprovedGitLabOrigins,
} from "../../src/domain/gitLab";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

suite("approved GitLab links", () => {
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
      projects.map(({ approvedOrigin, projectPath, remoteName }) => ({
        origin: approvedOrigin.origin,
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
    const [approvedOrigin] = parseApprovedGitLabOrigins(["https://gitlab.example.test:8443"]);
    assert.ok(approvedOrigin);
    const project = {
      approvedOrigin,
      projectPath: "group/sub group/project",
      remoteName: "origin",
    };
    assert.equal(
      buildApprovedGitLabUrl(project, { kind: "project" }),
      "https://gitlab.example.test:8443/group/sub%20group/project",
    );
    assert.equal(
      buildApprovedGitLabUrl(project, { kind: "commit", sha: SHA_A }),
      `https://gitlab.example.test:8443/group/sub%20group/project/-/commit/${SHA_A}`,
    );
    assert.equal(
      buildApprovedGitLabUrl(project, { kind: "tree", sha: SHA_A }),
      `https://gitlab.example.test:8443/group/sub%20group/project/-/tree/${SHA_A}`,
    );
    assert.equal(
      buildApprovedGitLabUrl(project, { baseSha: SHA_A, kind: "compare", targetSha: SHA_B }),
      `https://gitlab.example.test:8443/group/sub%20group/project/-/compare/${SHA_A}...${SHA_B}`,
    );
    assert.equal(
      buildApprovedGitLabUrl(project, {
        endLine: 12,
        filePath: "src/space name.ts",
        kind: "file",
        sha: SHA_A,
        startLine: 10,
      }),
      `https://gitlab.example.test:8443/group/sub%20group/project/-/blob/${SHA_A}/src/space%20name.ts#L10-12`,
    );
    assert.equal(
      buildApprovedGitLabUrl(project, { kind: "issue", number: 42 }),
      "https://gitlab.example.test:8443/group/sub%20group/project/-/issues/42",
    );
    assert.equal(
      buildApprovedGitLabUrl(project, { kind: "mergeRequest", number: 7 }),
      "https://gitlab.example.test:8443/group/sub%20group/project/-/merge_requests/7",
    );
  });

  test("fails closed for invalid targets and origin changes", () => {
    const [approvedOrigin] = parseApprovedGitLabOrigins(["https://gitlab.example.test"]);
    assert.ok(approvedOrigin);
    const project = { approvedOrigin, projectPath: "group/project", remoteName: "origin" };
    assert.throws(
      () => buildApprovedGitLabUrl(project, { kind: "commit", sha: "HEAD" }),
      /revision/iu,
    );
    assert.throws(
      () =>
        buildApprovedGitLabUrl(project, {
          filePath: "../secret",
          kind: "file",
          sha: SHA_A,
        }),
      /path/iu,
    );
    assert.throws(() => buildApprovedGitLabUrl(project, { kind: "issue", number: 0 }), /number/iu);
    assert.throws(
      () =>
        buildApprovedGitLabUrl(
          { ...project, projectPath: "group/project/../../outside" },
          { kind: "project" },
        ),
      /approved origin|invalid/iu,
    );
  });
});
