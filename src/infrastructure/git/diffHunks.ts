import type { ChangedLineRange } from "../../domain/fileAnnotations";

const HUNK_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu;

export function parseChangedLineRanges(output: string): ChangedLineRange[] {
  const ranges: ChangedLineRange[] = [];
  for (const match of output.matchAll(HUNK_PATTERN)) {
    const startText = match[1];
    if (!startText) throw new Error("Git returned an invalid diff hunk.");
    const startLine = Number.parseInt(startText, 10);
    const lineCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(lineCount)) {
      throw new Error("Git returned an invalid diff hunk range.");
    }
    ranges.push({ lineCount, startLine });
  }
  return ranges;
}
