/** Full object IDs emitted by supported SHA-1 and SHA-256 Git repositories. */
export const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

declare const gitObjectIdBrand: unique symbol;

/** A full, syntax-validated Git object ID. */
export type GitObjectId = string & { readonly [gitObjectIdBrand]: true };

/** Returns whether a value is a canonical full Git object ID. */
export function isGitObjectId(value: unknown): value is GitObjectId {
  return typeof value === "string" && GIT_OBJECT_ID_PATTERN.test(value);
}

/** Validates and normalizes a full Git object ID. */
export function requireGitObjectId(value: string, errorMessage: string): GitObjectId {
  if (!isGitObjectId(value)) throw new Error(errorMessage);
  return value.toLowerCase() as GitObjectId;
}
