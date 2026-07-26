const MAX_JAVASCRIPT_DATE_EPOCH_SECONDS = 8_640_000_000_000;
const GIT_EPOCH_SECONDS_PATTERN = /^(?:0|[1-9]\d*)$/u;

/** Parses Git's decimal Unix timestamp into the range supported by JavaScript dates. */
export function parseGitEpochSeconds(value: unknown): number | null {
  if (typeof value !== "string" || !GIT_EPOCH_SECONDS_PATTERN.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= MAX_JAVASCRIPT_DATE_EPOCH_SECONDS
    ? seconds
    : null;
}
