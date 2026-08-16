import type { BranchRef } from "./comparison";

export type FileAnnotationMode = "blame" | "changes" | "heatmap" | "off";
export type FileBlameFormat = "compact" | "detailed";
export type HeatmapBucket = "day" | "month" | "old" | "uncommitted" | "week" | "year";
export type HeatmapLocation = "edge" | "line" | "overview";
export type HeatmapToggleMode = "file" | "window";

export const CHANGES_ANNOTATION_STORAGE_KEY = "refhaven.fileAnnotations.changes.v1";

export interface SavedChangesAnnotationV1 {
  readonly baseRef: BranchRef;
  readonly repositoryRoot: string;
  readonly schemaVersion: 1;
}

export const HEATMAP_BUCKETS = [
  "uncommitted",
  "day",
  "week",
  "month",
  "year",
  "old",
] as const satisfies readonly HeatmapBucket[];

export const HEATMAP_BUCKET_DETAILS: Readonly<
  Record<HeatmapBucket, { readonly age: string; readonly label: string }>
> = {
  day: { age: "Committed within the last 24 hours", label: "Last 24 hours" },
  month: { age: "Committed more than 7 and up to 30 days ago", label: "Last 30 days" },
  old: { age: "Committed more than one year ago", label: "Older" },
  uncommitted: { age: "Not committed", label: "Working tree" },
  week: { age: "Committed more than 24 hours and up to 7 days ago", label: "Last 7 days" },
  year: { age: "Committed more than 30 and up to 365 days ago", label: "Last year" },
};

export const HEATMAP_LOCATIONS = [
  "edge",
  "overview",
  "line",
] as const satisfies readonly HeatmapLocation[];
export const DEFAULT_HEATMAP_LOCATIONS = [
  "edge",
  "overview",
] as const satisfies readonly HeatmapLocation[];

export interface ChangedLineRange {
  /** One-based first line in the current working-tree file. */
  readonly startLine: number;
  /** Zero means the hunk contains only deleted lines. */
  readonly lineCount: number;
}

export function heatmapBucket(authorDate: number | null, now: number): HeatmapBucket {
  if (authorDate === null) return "uncommitted";
  const ageDays = Math.max(0, now - authorDate) / 86_400_000;
  if (ageDays <= 1) return "day";
  if (ageDays <= 7) return "week";
  if (ageDays <= 30) return "month";
  if (ageDays <= 365) return "year";
  return "old";
}

/** Computes a direct heatmap toggle without trusting asynchronously refreshed controller state. */
export function toggledHeatmapMode(
  activeMode: FileAnnotationMode,
  configuredMode: Exclude<FileAnnotationMode, "changes">,
): Exclude<FileAnnotationMode, "blame" | "changes"> {
  const displayedMode = activeMode === "changes" ? activeMode : configuredMode;
  return displayedMode === "heatmap" ? "off" : "heatmap";
}

/** Returns the smallest per-file override needed to reach the requested heatmap state. */
export function heatmapFileModeOverride(
  baseMode: FileAnnotationMode,
  enabled: boolean,
): "heatmap" | "off" | null {
  if (enabled) return baseMode === "heatmap" ? null : "heatmap";
  return baseMode === "heatmap" ? "off" : null;
}

/** Returns a stable, duplicate-free rendering configuration or the safe default. */
export function normalizeHeatmapLocations(value: unknown): readonly HeatmapLocation[] {
  if (!Array.isArray(value)) return DEFAULT_HEATMAP_LOCATIONS;
  const selected = new Set(
    value.filter((entry): entry is HeatmapLocation => isHeatmapLocation(entry)),
  );
  const locations = HEATMAP_LOCATIONS.filter((location) => selected.has(location));
  return locations.length > 0 ? locations : DEFAULT_HEATMAP_LOCATIONS;
}

export function normalizeFileBlameFormat(value: unknown): FileBlameFormat {
  return value === "compact" ? value : "detailed";
}

export function normalizeHeatmapToggleMode(value: unknown): HeatmapToggleMode {
  return value === "window" ? value : "file";
}

function isHeatmapLocation(value: unknown): value is HeatmapLocation {
  return value === "edge" || value === "line" || value === "overview";
}
