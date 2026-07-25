import { basename, isAbsolute } from "node:path";

import * as vscode from "vscode";

import { readFileAtRevision } from "../../infrastructure/git/GitCli";

export const REVISION_DOCUMENT_SCHEME = "branch-compare";

interface EmptyRevisionRequest {
  readonly kind: "empty";
}

interface GitRevisionRequest {
  readonly filePath: string;
  readonly kind: "revision";
  readonly repositoryRoot: string;
  readonly sha: string;
}

type RevisionRequest = EmptyRevisionRequest | GitRevisionRequest;

export class BinaryRevisionError extends Error {
  public constructor() {
    super("Binary files cannot be displayed as a text diff.");
    this.name = "BinaryRevisionError";
  }
}

export class GitRevisionContentProvider implements vscode.TextDocumentContentProvider {
  private readonly allowedUris = new Set<string>();
  private readonly contentByUri = new Map<string, Promise<string>>();

  public createEmptyUri(filePath: string): vscode.Uri {
    validateGitPath(filePath);
    return this.createUri({ kind: "empty" }, filePath);
  }

  public createRevisionUri(repositoryRoot: string, sha: string, filePath: string): vscode.Uri {
    if (!isAbsolute(repositoryRoot)) throw new Error("Repository root must be absolute.");
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error("Revision SHA is invalid.");
    validateGitPath(filePath);
    return this.createUri({ filePath, kind: "revision", repositoryRoot, sha }, filePath);
  }

  public provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return this.loadContent(uri);
  }

  public async prepareTextDiff(left: vscode.Uri, right: vscode.Uri): Promise<void> {
    await Promise.all([this.loadContent(left), this.loadContent(right)]);
  }

  private createUri(request: RevisionRequest, filePath: string): vscode.Uri {
    const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
    const uri = vscode.Uri.from({
      path: `/revision/${basename(filePath) || "empty"}`,
      query: payload,
      scheme: REVISION_DOCUMENT_SCHEME,
    });
    this.allowedUris.add(uri.toString());
    return uri;
  }

  private loadContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    if (!this.allowedUris.has(key)) {
      return Promise.reject(new Error("Unknown Branch Compare revision document."));
    }

    const cached = this.contentByUri.get(key);
    if (cached) return cached;

    const content = this.readContent(uri);
    this.contentByUri.set(key, content);
    return content;
  }

  private async readContent(uri: vscode.Uri): Promise<string> {
    const request = parseRequest(uri.query);
    if (request.kind === "empty") return "";

    const content = await readFileAtRevision(request.repositoryRoot, request.sha, request.filePath);
    if (content.includes(0)) throw new BinaryRevisionError();

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch (error) {
      if (error instanceof BinaryRevisionError) throw error;
      throw new BinaryRevisionError();
    }
  }
}

function parseRequest(payload: string): RevisionRequest {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Branch Compare revision URI is invalid.");
  }

  if (!value || typeof value !== "object") {
    throw new Error("Branch Compare revision URI is invalid.");
  }
  const request = value as Record<string, unknown>;
  if (request.kind === "empty") return { kind: "empty" };
  if (
    request.kind !== "revision" ||
    typeof request.repositoryRoot !== "string" ||
    !isAbsolute(request.repositoryRoot) ||
    typeof request.sha !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(request.sha) ||
    typeof request.filePath !== "string"
  ) {
    throw new Error("Branch Compare revision URI is invalid.");
  }
  validateGitPath(request.filePath);
  return {
    filePath: request.filePath,
    kind: "revision",
    repositoryRoot: request.repositoryRoot,
    sha: request.sha,
  };
}

function validateGitPath(filePath: string): void {
  if (
    filePath.length === 0 ||
    filePath.includes("\0") ||
    filePath.startsWith("/") ||
    /^[a-z]:[\\/]/i.test(filePath) ||
    filePath.split("/").includes("..")
  ) {
    throw new Error("Git revision path is invalid.");
  }
}
