const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/iu;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/iu;
const SCP_REMOTE_PATTERN = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/u;

export interface ApprovedGitLabOrigin {
  readonly hostname: string;
  readonly origin: string;
}

export interface GitRemoteUrl {
  readonly name: string;
  readonly url: string;
}

export interface GitLabProject {
  readonly approvedOrigin: ApprovedGitLabOrigin;
  readonly projectPath: string;
  readonly remoteName: string;
}

export type GitLabTarget =
  | { readonly kind: "commit"; readonly sha: string }
  | {
      readonly endLine?: number;
      readonly filePath: string;
      readonly kind: "file";
      readonly sha: string;
      readonly startLine?: number;
    }
  | { readonly baseSha: string; readonly kind: "compare"; readonly targetSha: string }
  | { readonly kind: "issue"; readonly number: number }
  | { readonly kind: "mergeRequest"; readonly number: number }
  | { readonly kind: "project" }
  | { readonly kind: "tree"; readonly sha: string };

export function parseApprovedGitLabOrigins(values: readonly unknown[]): ApprovedGitLabOrigin[] {
  if (values.length > 20) throw new Error("At most 20 GitLab origins may be approved.");
  const origins = new Map<string, ApprovedGitLabOrigin>();
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length > 2_048) {
      throw new Error(
        `Approved GitLab origin entry ${(index + 1).toString()} must be a string of at most 2048 characters.`,
      );
    }
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(`Approved GitLab origin entry ${(index + 1).toString()} is invalid.`);
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error(
        `Approved GitLab origin entry ${(index + 1).toString()} must be an exact HTTP(S) origin.`,
      );
    }
    origins.set(url.origin, {
      hostname: normalizeHostname(url.hostname),
      origin: url.origin,
    });
  }
  return [...origins.values()];
}

export function matchApprovedGitLabProjects(
  remotes: readonly GitRemoteUrl[],
  approvedOrigins: readonly ApprovedGitLabOrigin[],
): GitLabProject[] {
  const projects = new Map<string, GitLabProject>();
  for (const remote of remotes) {
    const parsed = parseRemote(remote.url);
    if (!parsed) continue;
    const matchingOrigins =
      parsed.transport === "http"
        ? approvedOrigins.filter(({ origin }) => origin === parsed.remoteOrigin)
        : approvedOrigins.filter(({ hostname }) => hostname === parsed.hostname);
    for (const approvedOrigin of matchingOrigins) {
      const key = `${approvedOrigin.origin}\0${parsed.projectPath}`;
      const existing = projects.get(key);
      if (!existing || (remote.name === "origin" && existing.remoteName !== "origin")) {
        projects.set(key, {
          approvedOrigin,
          projectPath: parsed.projectPath,
          remoteName: remote.name,
        });
      }
    }
  }
  return [...projects.values()].sort(
    (left, right) =>
      Number(right.remoteName === "origin") - Number(left.remoteName === "origin") ||
      left.projectPath.localeCompare(right.projectPath, undefined, {
        numeric: true,
        sensitivity: "base",
      }) ||
      left.approvedOrigin.origin.localeCompare(right.approvedOrigin.origin),
  );
}

export function buildApprovedGitLabUrl(project: GitLabProject, target: GitLabTarget): string {
  const projectUrl = `${project.approvedOrigin.origin}/${encodeProjectPath(project.projectPath)}`;
  let value: string;
  switch (target.kind) {
    case "project":
      value = projectUrl;
      break;
    case "commit":
      value = `${projectUrl}/-/commit/${requireObjectId(target.sha)}`;
      break;
    case "tree":
      value = `${projectUrl}/-/tree/${requireObjectId(target.sha)}`;
      break;
    case "compare":
      value = `${projectUrl}/-/compare/${requireObjectId(target.baseSha)}...${requireObjectId(
        target.targetSha,
      )}`;
      break;
    case "issue":
      value = `${projectUrl}/-/issues/${requirePositiveInteger(target.number)}`;
      break;
    case "mergeRequest":
      value = `${projectUrl}/-/merge_requests/${requirePositiveInteger(target.number)}`;
      break;
    case "file": {
      const path = encodeGitLabFilePath(target.filePath);
      const fragment = lineFragment(target.startLine, target.endLine);
      value = `${projectUrl}/-/blob/${requireObjectId(target.sha)}/${path}${fragment}`;
      break;
    }
  }
  const url = new URL(value);
  if (
    url.origin !== project.approvedOrigin.origin ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("RefHaven refused a GitLab URL outside the approved origin.");
  }
  return url.toString();
}

function parseRemote(urlValue: string):
  | {
      readonly hostname: string;
      readonly projectPath: string;
      readonly remoteOrigin?: undefined;
      readonly transport: "ssh";
    }
  | {
      readonly hostname: string;
      readonly projectPath: string;
      readonly remoteOrigin: string;
      readonly transport: "http";
    }
  | null {
  const value = urlValue.trim();
  if (value.length === 0 || value.length > 4_096 || value.includes("\0")) return null;
  if (!value.includes("://")) {
    if (WINDOWS_DRIVE_PATH.test(value)) return null;
    const match = SCP_REMOTE_PATTERN.exec(value);
    const hostname = match?.[1];
    const path = match?.[2];
    if (!hostname || !path) return null;
    const projectPath = normalizeProjectPath(path, false);
    return projectPath
      ? {
          hostname: normalizeHostname(hostname),
          projectPath,
          transport: "ssh",
        }
      : null;
  }
  try {
    const url = new URL(value);
    if (url.search.length > 0 || url.hash.length > 0) return null;
    if (url.protocol === "http:" || url.protocol === "https:") {
      const projectPath = normalizeProjectPath(url.pathname, true);
      return projectPath
        ? {
            hostname: normalizeHostname(url.hostname),
            projectPath,
            remoteOrigin: url.origin,
            transport: "http",
          }
        : null;
    }
    if (url.protocol === "ssh:") {
      const projectPath = normalizeProjectPath(url.pathname, true);
      return projectPath
        ? {
            hostname: normalizeHostname(url.hostname),
            projectPath,
            transport: "ssh",
          }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeProjectPath(value: string, encoded: boolean): string | null {
  const rawSegments = value.replace(/^\/+|\/+$/gu, "").split("/");
  if (rawSegments.length < 2) return null;
  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    let segment: string;
    try {
      segment = encoded ? decodeURIComponent(rawSegment) : rawSegment;
    } catch {
      return null;
    }
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      hasControlCharacter(segment)
    ) {
      return null;
    }
    segments.push(segment);
  }
  const projectName = segments.at(-1)?.replace(/\.git$/iu, "");
  if (!projectName) return null;
  segments[segments.length - 1] = projectName;
  return segments.join("/");
}

function encodeGitLabFilePath(filePath: string): string {
  const segments = filePath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        hasControlCharacter(segment),
    )
  ) {
    throw new Error("The GitLab file path is invalid.");
  }
  return segments.map(encodeURIComponent).join("/");
}

function encodeProjectPath(projectPath: string): string {
  const segments = projectPath.split("/");
  if (segments.length < 2) throw new Error("The GitLab project path is invalid.");
  return encodeGitLabFilePath(projectPath);
}

function lineFragment(startLine: number | undefined, endLine: number | undefined): string {
  if (startLine === undefined && endLine === undefined) return "";
  const start = requirePositiveInteger(startLine ?? endLine);
  const end = requirePositiveInteger(endLine ?? startLine);
  if (end < start) throw new Error("The GitLab line range is invalid.");
  return end === start ? `#L${start}` : `#L${start}-${end}`;
}

function requireObjectId(value: string): string {
  if (!OBJECT_ID_PATTERN.test(value)) throw new Error("The GitLab revision is invalid.");
  return value.toLowerCase();
}

function requirePositiveInteger(value: number | undefined): string {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("The GitLab reference number is invalid.");
  }
  return value.toString();
}

function normalizeHostname(value: string): string {
  return value.toLowerCase();
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
