export type FileAnnotationMode = "blame" | "changes" | "heatmap" | "off";
export type HeatmapBucket = "day" | "month" | "old" | "week" | "year";

export interface ChangedLineRange {
  /** One-based first line in the current working-tree file. */
  readonly startLine: number;
  /** Zero means the hunk contains only deleted lines. */
  readonly lineCount: number;
}

export function heatmapBucket(authorDate: number, now: number): HeatmapBucket {
  const ageDays = Math.max(0, now - authorDate) / 86_400_000;
  if (ageDays <= 1) return "day";
  if (ageDays <= 7) return "week";
  if (ageDays <= 30) return "month";
  if (ageDays <= 365) return "year";
  return "old";
}
