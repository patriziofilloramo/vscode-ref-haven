import { isAbsolute } from "node:path";

import type * as vscode from "vscode";

import {
  CHANGES_ANNOTATION_STORAGE_KEY,
  type SavedChangesAnnotationV1,
} from "../domain/fileAnnotations";
import { isBranchRef } from "../domain/validation";

const MAX_PERSISTED_ROOT_LENGTH = 32_768;
const MAX_PERSISTED_REF_LABEL_LENGTH = 512;

type WorkspaceState = Pick<vscode.ExtensionContext["workspaceState"], "get" | "update">;

/** Owns the validated workspace-local baseline used by changes annotations. */
export class FileAnnotationChangesStore {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly workspaceState: WorkspaceState) {}

  public get(): SavedChangesAnnotationV1 | undefined {
    const value = this.workspaceState.get<unknown>(CHANGES_ANNOTATION_STORAGE_KEY);
    return isSavedChangesAnnotation(value) ? value : undefined;
  }

  public set(selection: SavedChangesAnnotationV1 | undefined): Promise<void> {
    if (selection !== undefined && !isSavedChangesAnnotation(selection)) {
      return Promise.reject(new Error("The changes annotation baseline is invalid."));
    }
    return this.enqueueWrite(() =>
      this.workspaceState.update(CHANGES_ANNOTATION_STORAGE_KEY, selection),
    );
  }

  private enqueueWrite(operation: () => Thenable<void>): Promise<void> {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

export function isSavedChangesAnnotation(value: unknown): value is SavedChangesAnnotationV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SavedChangesAnnotationV1>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.repositoryRoot === "string" &&
    candidate.repositoryRoot.length > 0 &&
    candidate.repositoryRoot.length <= MAX_PERSISTED_ROOT_LENGTH &&
    !candidate.repositoryRoot.includes("\0") &&
    isAbsolute(candidate.repositoryRoot) &&
    isBranchRef(candidate.baseRef) &&
    candidate.baseRef.kind !== "workingTree" &&
    candidate.baseRef.displayName.length <= MAX_PERSISTED_REF_LABEL_LENGTH &&
    candidate.baseRef.fullName.length <= MAX_PERSISTED_REF_LABEL_LENGTH
  );
}
