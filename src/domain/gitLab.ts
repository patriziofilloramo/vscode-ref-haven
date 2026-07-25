import { requireGitObjectId } from "./gitObjectId";

const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/iu;
const SCP_REMOTE_PATTERN = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/u;

export interface GitLabBrowserOrigin {
  readonly hostname: string;
  readonly origin: string;
}

export interface GitRemoteUrl {
  readonly name: string;
  readonly url: string;
}

export interface GitLabProject {
  readonly browserOrigin: GitLabBrowserOrigin;
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

export function parseApprovedGitLabOrigins(values: readonly unknown[]): GitLabBrowserOrigin[] {
  if (values.length > 20) throw new Error("At most 20 GitLab origins may be approved.");
  const origins = new Map<string, GitLabBrowserOrigin>();
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
  approvedOrigins: readonly GitLabBrowserOrigin[],
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
      addProject(projects, approvedOrigin, parsed.projectPath, remote.name);
    }
  }
  return sortProjects(projects);
}

/**
 * Derives browser projects from validated local remotes when no organisation
 * allowlist is configured. HTTP(S) keeps its exact origin; SSH defaults to
 * HTTPS on the same hostname. Invalid and local-path remotes are ignored.
 */
export function inferGitLabProjects(remotes: readonly GitRemoteUrl[]): GitLabProject[] {
  const projects = new Map<string, GitLabProject>();
  for (const remote of remotes) {
    const parsed = parseRemote(remote.url);
    if (!parsed) continue;
    const inferredOrigin =
      parsed.transport === "http"
        ? browserOriginFromUrl(parsed.remoteOrigin)
        : browserOriginFromUrl(`https://${parsed.hostname}`);
    if (!inferredOrigin) continue;
    addProject(projects, inferredOrigin, parsed.projectPath, remote.name);
  }
  return sortProjects(projects);
}

/** Applies zero-config inference or strict allowlist matching as one policy boundary. */
export function resolveGitLabProjects(
  remotes: readonly GitRemoteUrl[],
  approvedOrigins: readonly GitLabBrowserOrigin[],
): GitLabProject[] {
  return approvedOrigins.length > 0
    ? matchApprovedGitLabProjects(remotes, approvedOrigins)
    : inferGitLabProjects(remotes);
}

function sortProjects(projects: ReadonlyMap<string, GitLabProject>): GitLabProject[] {
  return [...projects.values()].sort(
    (left, right) =>
      Number(right.remoteName === "origin") - Number(left.remoteName === "origin") ||
      left.projectPath.localeCompare(right.projectPath, undefined, {
        numeric: true,
        sensitivity: "base",
      }) ||
      left.browserOrigin.origin.localeCompare(right.browserOrigin.origin),
  );
}

export function buildGitLabUrl(project: GitLabProject, target: GitLabTarget): string {
  const projectUrl = `${project.browserOrigin.origin}/${encodeProjectPath(project.projectPath)}`;
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
    url.origin !== project.browserOrigin.origin ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("RefHaven refused a GitLab URL outside the allowed origin.");
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

function browserOriginFromUrl(value: string): GitLabBrowserOrigin | null {
  try {
    return parseApprovedGitLabOrigins([value])[0] ?? null;
  } catch {
    return null;
  }
}

function addProject(
  projects: Map<string, GitLabProject>,
  browserOrigin: GitLabBrowserOrigin,
  projectPath: string,
  remoteName: string,
): void {
  const key = `${browserOrigin.origin}\0${projectPath}`;
  const existing = projects.get(key);
  if (!existing || (remoteName === "origin" && existing.remoteName !== "origin")) {
    projects.set(key, { browserOrigin, projectPath, remoteName });
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
  return requireGitObjectId(value, "The GitLab revision is invalid.");
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
