import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, isAbsolute } from "node:path";

import * as vscode from "vscode";

import { isGitObjectId } from "../../domain/gitObjectId";
import { assertRepositoryRelativeGitPath } from "../../domain/pathValidation";
import { readFileAtRevision } from "../../infrastructure/git/GitCli";
import { BoundedPromiseCache } from "./BoundedPromiseCache";

export const REVISION_DOCUMENT_SCHEME = "refhaven";

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

/** Verified identity of a RefHaven revision document. */
export interface RevisionDocumentIdentity {
  readonly filePath: string;
  readonly repositoryRoot: string;
  readonly sha: string;
}

export class BinaryRevisionError extends Error {
  public constructor() {
    super("Binary files cannot be displayed as a text diff.");
    this.name = "BinaryRevisionError";
  }
}

export class GitRevisionContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contentByUri = new BoundedPromiseCache<string>(64, 16 * 1024 * 1024, (value) =>
    Buffer.byteLength(value, "utf8"),
  );
  private readonly signingKey = randomBytes(32);

  public createEmptyUri(filePath: string): vscode.Uri {
    assertRepositoryRelativeGitPath(filePath);
    return this.createUri({ kind: "empty" }, filePath);
  }

  public createRevisionUri(repositoryRoot: string, sha: string, filePath: string): vscode.Uri {
    if (!isAbsolute(repositoryRoot)) throw new Error("Repository root must be absolute.");
    if (!isGitObjectId(sha)) throw new Error("Revision SHA is invalid.");
    assertRepositoryRelativeGitPath(filePath);
    return this.createUri({ filePath, kind: "revision", repositoryRoot, sha }, filePath);
  }

  public provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return this.loadContent(uri);
  }

  /**
   * Returns the revision identity of a URI this provider signed, or null.
   * Only HMAC-verified URIs are trusted, so document metadata cannot be
   * forged by other extensions or restored editor state.
   */
  public parseVerifiedRevisionUri(uri: vscode.Uri): RevisionDocumentIdentity | null {
    if (uri.scheme !== REVISION_DOCUMENT_SCHEME) return null;
    try {
      const request = parseRequest(this.verifyAndExtractPayload(uri.query));
      if (request.kind !== "revision") return null;
      return {
        filePath: request.filePath,
        repositoryRoot: request.repositoryRoot,
        sha: request.sha.toLowerCase(),
      };
    } catch {
      return null;
    }
  }

  public async prepareTextDiff(left: vscode.Uri, right: vscode.Uri): Promise<void> {
    await Promise.all(
      [left, right]
        .filter((uri) => uri.scheme === REVISION_DOCUMENT_SCHEME)
        .map((uri) => this.loadContent(uri)),
    );
  }

  public dispose(): void {
    this.contentByUri.clear();
  }

  private createUri(request: RevisionRequest, filePath: string): vscode.Uri {
    const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
    const signature = this.sign(payload);
    const uri = vscode.Uri.from({
      path: `/revision/${basename(filePath) || "empty"}`,
      query: `${payload}.${signature}`,
      scheme: REVISION_DOCUMENT_SCHEME,
    });
    return uri;
  }

  private loadContent(uri: vscode.Uri): Promise<string> {
    try {
      const key = uri.toString();
      const payload = this.verifyAndExtractPayload(uri.query);
      return this.contentByUri.getOrCreate(key, () => this.readContent(payload));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("Invalid revision URI."));
    }
  }

  private async readContent(payload: string): Promise<string> {
    const request = parseRequest(payload);
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

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("base64url");
  }

  private verifyAndExtractPayload(token: string): string {
    if (token.length > 32 * 1024) throw new Error("RefHaven revision URI is invalid.");
    const separator = token.lastIndexOf(".");
    if (separator <= 0 || separator === token.length - 1) {
      throw new Error("Unknown RefHaven revision document.");
    }
    const payload = token.slice(0, separator);
    const encodedSignature = token.slice(separator + 1);
    const signature = Buffer.from(encodedSignature, "base64url");
    const expected = Buffer.from(this.sign(payload), "base64url");
    if (
      signature.toString("base64url") !== encodedSignature ||
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    ) {
      throw new Error("Unknown RefHaven revision document.");
    }
    return payload;
  }
}

function parseRequest(payload: string): RevisionRequest {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("RefHaven revision URI is invalid.");
  }

  if (!value || typeof value !== "object") {
    throw new Error("RefHaven revision URI is invalid.");
  }
  const request = value as Record<string, unknown>;
  if (request.kind === "empty") return { kind: "empty" };
  if (
    request.kind !== "revision" ||
    typeof request.repositoryRoot !== "string" ||
    !isAbsolute(request.repositoryRoot) ||
    typeof request.sha !== "string" ||
    !isGitObjectId(request.sha) ||
    typeof request.filePath !== "string"
  ) {
    throw new Error("RefHaven revision URI is invalid.");
  }
  assertRepositoryRelativeGitPath(request.filePath);
  return {
    filePath: request.filePath,
    kind: "revision",
    repositoryRoot: request.repositoryRoot,
    sha: request.sha,
  };
}
