import { requireGitObjectId } from "./gitObjectId";

const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/iu;
const SCP_REMOTE_PATTERN = /^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/u;

/**
 * Which browser URL grammar a host speaks. Detection is by hostname only —
 * RefHaven never asks the host what it is. `azure` is recognised precisely so
 * that its links can be refused: Azure DevOps addresses files through query
 * parameters rather than a path, and a guessed URL would open a dead page.
 */
export type RemoteHostKind = "azure" | "bitbucket" | "gitea" | "github" | "gitlab";

export interface GitLabBrowserOrigin {
  readonly hostKind: RemoteHostKind;
  readonly hostname: string;
  readonly origin: string;
}

/** Human-readable name for a detected host grammar, for messages and tooltips. */
export function describeHostKind(hostKind: RemoteHostKind): string {
  switch (hostKind) {
    case "azure":
      return "Azure DevOps";
    case "bitbucket":
      return "Bitbucket";
    case "gitea":
      return "Gitea";
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
  }
}

/**
 * Detects the URL grammar from the hostname alone.
 *
 * The exact public hostnames are certain. Self-hosted instances use arbitrary
 * hostnames, so the product name is looked for as a leading label — the
 * `gitlab.company.example` convention — which is a guess and can be wrong.
 * GitLab remains the fallback because it is the most common self-hosted Git
 * forge; a wrong guess is correctable through the host-grammar setting.
 */
export function detectRemoteHostKind(hostname: string): RemoteHostKind {
  const normalized = normalizeHostname(hostname).replace(/^www\./u, "");
  const known: Readonly<Record<string, RemoteHostKind>> = {
    "bitbucket.org": "bitbucket",
    "codeberg.org": "gitea",
    "dev.azure.com": "azure",
    "github.com": "github",
    "gitlab.com": "gitlab",
  };
  const exact = known[normalized];
  if (exact) return exact;
  if (normalized.endsWith(".visualstudio.com")) return "azure";
  const label = normalized.split(".")[0] ?? "";
  if (label === "github") return "github";
  if (label === "bitbucket") return "bitbucket";
  if (label === "gitea" || label === "forgejo") return "gitea";
  return "gitlab";
}

/**
 * Applies an explicit host-grammar choice to resolved projects. Hostname
 * detection is a heuristic for self-hosted instances, so the user must be able
 * to state the answer outright rather than rely on the guess. `auto` keeps the
 * detected grammar; an unrecognised value is ignored rather than trusted.
 */
export function applyHostGrammarOverride(
  projects: readonly GitLabProject[],
  override: unknown,
): GitLabProject[] {
  const kinds: readonly RemoteHostKind[] = ["azure", "bitbucket", "gitea", "github", "gitlab"];
  const hostKind = kinds.find((kind) => kind === override);
  if (!hostKind) return [...projects];
  return projects.map((project) => ({
    ...project,
    browserOrigin: { ...project.browserOrigin, hostKind },
  }));
}

/**
 * Whether a host can address a target at all. A host that cannot is refused
 * rather than approximated: no link is honest, a dead link is not.
 */
export function supportsBrowserTarget(
  hostKind: RemoteHostKind,
  kind: GitLabTarget["kind"],
): boolean {
  if (hostKind === "azure") return false;
  // Bitbucket compares refs through a query-driven branch view with no stable
  // commit-to-commit address, so comparison links are not offered there.
  return !(hostKind === "bitbucket" && kind === "compare");
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
  if (values.length > 20) throw new Error("At most 20 browser origins may be approved.");
  const origins = new Map<string, GitLabBrowserOrigin>();
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || value.length > 2_048) {
      throw new Error(
        `Approved browser origin entry ${(index + 1).toString()} must be a string of at most 2048 characters.`,
      );
    }
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(`Approved browser origin entry ${(index + 1).toString()} is invalid.`);
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
        `Approved browser origin entry ${(index + 1).toString()} must be an exact HTTP(S) origin.`,
      );
    }
    origins.set(url.origin, {
      hostKind: detectRemoteHostKind(url.hostname),
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

/**
 * Builds a browser URL in the path shape the detected host actually uses.
 * GitHub and GitLab differ in the `/-/` scope segment, in how a merge or
 * pull request is addressed, and in their line-range fragment.
 */
export function buildGitLabUrl(project: GitLabProject, target: GitLabTarget): string {
  const projectUrl = `${project.browserOrigin.origin}/${encodeProjectPath(project.projectPath)}`;
  const { hostKind } = project.browserOrigin;
  if (!supportsBrowserTarget(hostKind, target.kind)) {
    throw new Error(
      `${describeHostKind(hostKind)} has no browser address RefHaven can build for this target.`,
    );
  }
  const url = new URL(`${projectUrl}${targetPath(hostKind, target)}`);
  if (
    url.origin !== project.browserOrigin.origin ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("RefHaven refused a browser URL outside the allowed origin.");
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
    throw new Error("The browser file path is invalid.");
  }
  return segments.map(encodeURIComponent).join("/");
}

function encodeProjectPath(projectPath: string): string {
  const segments = projectPath.split("/");
  if (segments.length < 2) throw new Error("The browser project path is invalid.");
  return encodeGitLabFilePath(projectPath);
}

/**
 * The path and fragment a host appends to the project URL for a target.
 *
 * The forges agree on far less than they appear to: GitLab scopes every
 * project route under `/-/`, Gitea addresses blobs as `/src/commit/`,
 * Bitbucket as `/src/` with a `#lines-` fragment, and each names a
 * pull or merge request differently.
 */
function targetPath(hostKind: RemoteHostKind, target: GitLabTarget): string {
  const scope = hostKind === "gitlab" ? "/-" : "";
  switch (target.kind) {
    case "project":
      return "";
    case "commit": {
      const sha = requireObjectId(target.sha);
      return hostKind === "bitbucket" ? `/commits/${sha}` : `${scope}/commit/${sha}`;
    }
    case "tree": {
      const sha = requireObjectId(target.sha);
      switch (hostKind) {
        case "bitbucket":
          return `/src/${sha}`;
        case "gitea":
          return `/src/commit/${sha}`;
        default:
          return `${scope}/tree/${sha}`;
      }
    }
    case "compare":
      return `${scope}/compare/${requireObjectId(target.baseSha)}...${requireObjectId(
        target.targetSha,
      )}`;
    case "issue":
      return `${scope}/issues/${requirePositiveInteger(target.number)}`;
    case "mergeRequest": {
      const number = requirePositiveInteger(target.number);
      switch (hostKind) {
        case "bitbucket":
          return `/pull-requests/${number}`;
        case "gitea":
          return `/pulls/${number}`;
        case "gitlab":
          return `/-/merge_requests/${number}`;
        default:
          return `/pull/${number}`;
      }
    }
    case "file": {
      const sha = requireObjectId(target.sha);
      const path = encodeGitLabFilePath(target.filePath);
      const fragment = lineFragment(target.startLine, target.endLine, hostKind);
      switch (hostKind) {
        case "bitbucket":
          return `/src/${sha}/${path}${fragment}`;
        case "gitea":
          return `/src/commit/${sha}/${path}${fragment}`;
        default:
          return `${scope}/blob/${sha}/${path}${fragment}`;
      }
    }
  }
}

/**
 * Line ranges: GitHub and Gitea read `#L5-L9`, GitLab `#L5-9`, and Bitbucket
 * abandons the convention entirely with `#lines-5:9`.
 */
function lineFragment(
  startLine: number | undefined,
  endLine: number | undefined,
  hostKind: RemoteHostKind,
): string {
  if (startLine === undefined && endLine === undefined) return "";
  const start = requirePositiveInteger(startLine ?? endLine);
  const end = requirePositiveInteger(endLine ?? startLine);
  if (end < start) throw new Error("The browser line range is invalid.");
  if (hostKind === "bitbucket") return end === start ? `#lines-${start}` : `#lines-${start}:${end}`;
  if (end === start) return `#L${start}`;
  return hostKind === "gitlab" ? `#L${start}-${end}` : `#L${start}-L${end}`;
}

function requireObjectId(value: string): string {
  return requireGitObjectId(value, "The browser revision is invalid.");
}

function requirePositiveInteger(value: number | undefined): string {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("The browser reference number is invalid.");
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
