import type { HeatmapBucket } from "../domain/fileAnnotations";

export interface HeatmapColorIds {
  readonly background: string;
  readonly foreground: string;
}

/** Public VS Code color tokens used by the file heatmap. */
export const HEATMAP_COLOR_IDS: Readonly<Record<HeatmapBucket, HeatmapColorIds>> = {
  day: {
    background: "refhaven.heatmap.dayBackground",
    foreground: "refhaven.heatmap.dayForeground",
  },
  month: {
    background: "refhaven.heatmap.monthBackground",
    foreground: "refhaven.heatmap.monthForeground",
  },
  old: {
    background: "refhaven.heatmap.oldBackground",
    foreground: "refhaven.heatmap.oldForeground",
  },
  uncommitted: {
    background: "refhaven.heatmap.uncommittedBackground",
    foreground: "refhaven.heatmap.uncommittedForeground",
  },
  week: {
    background: "refhaven.heatmap.weekBackground",
    foreground: "refhaven.heatmap.weekForeground",
  },
  year: {
    background: "refhaven.heatmap.yearBackground",
    foreground: "refhaven.heatmap.yearForeground",
  },
};
