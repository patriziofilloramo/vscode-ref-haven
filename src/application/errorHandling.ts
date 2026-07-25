import type { Logger, LogMetadata } from "./Logger";

const SAFE_ERROR_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

/** Returns a stable, non-sensitive error identifier suitable for structured logs. */
export function errorIdentifier(error: unknown): string {
  const candidate = error as { readonly code?: unknown; readonly name?: unknown };
  for (const value of [candidate.code, candidate.name]) {
    if (typeof value === "string" && SAFE_ERROR_IDENTIFIER.test(value)) return value;
  }
  return error instanceof Error ? "Error" : "UnknownError";
}

/** Builds the only error metadata shape permitted in operational logs. */
export function errorLogMetadata(error: unknown, operation: string): LogMetadata {
  return { errorKind: errorIdentifier(error), operation };
}

/** Preserves safe domain messages for the user without copying them into logs. */
export function userFacingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "RefHaven command failed.";
}

/** Attaches consistent, privacy-safe logging to a fire-and-forget task. */
export function runInBackground(
  task: Promise<unknown>,
  logger: Logger,
  message: string,
  operation: string,
): void {
  void task.catch((error: unknown) => {
    logger.error(message, errorLogMetadata(error, operation));
  });
}
