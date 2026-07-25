const RELATIVE_TIME_STEPS: readonly {
  readonly ms: number;
  readonly unit: Intl.RelativeTimeFormatUnit;
}[] = [
  { ms: 1000 * 60 * 60 * 24 * 365, unit: "year" },
  { ms: 1000 * 60 * 60 * 24 * 30, unit: "month" },
  { ms: 1000 * 60 * 60 * 24 * 7, unit: "week" },
  { ms: 1000 * 60 * 60 * 24, unit: "day" },
  { ms: 1000 * 60 * 60, unit: "hour" },
  { ms: 1000 * 60, unit: "minute" },
];

export function formatRelativeTime(epochMs: number, nowMs: number = Date.now()): string {
  const elapsed = nowMs - epochMs;
  if (elapsed < 1000 * 60) return "just now";

  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "long" });
  for (const step of RELATIVE_TIME_STEPS) {
    if (elapsed >= step.ms) {
      return formatter.format(-Math.floor(elapsed / step.ms), step.unit);
    }
  }
  return "just now";
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Formats additions/deletions as a compact `+1,405 −23` summary. */
export function formatDiffStats(additions: number, deletions: number): string {
  return `+${formatCount(additions)} −${formatCount(deletions)}`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  const noun = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${formatCount(count)} ${noun}`;
}
