/**
 * Shapes a unified diff into the single section a line hover should show.
 *
 * Raw `git diff` output opens with file plumbing (`diff --git`, `index`,
 * `---`, `+++`) that repeats what the hover already states, and its first
 * hunk is often not the one that produced the hovered line. This module
 * strips the plumbing and selects the hunk containing that line, so the
 * preview answers "what happened *here*" instead of "what happened first".
 */

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

export interface DiffPreviewSection {
  /** Diff body lines only: context, additions, and deletions. */
  readonly bodyLines: readonly string[];
  /** 1-based position of the section's first line in the new file. */
  readonly newStartLine: number;
  /** Index of the hovered line within `bodyLines`, when it was located. */
  readonly targetIndex?: number;
  /** How many changed sections the file has in this commit. */
  readonly totalSections: number;
  /** Whether the returned section is the one containing the hovered line. */
  readonly containsTarget: boolean;
}

interface ParsedHunk {
  readonly bodyLines: string[];
  readonly newLineCount: number;
  readonly newStartLine: number;
}

/**
 * Returns the diff section to preview, or null when the patch carries no
 * textual change (binary or mode-only changes, which produce headers alone).
 */
export function selectDiffPreviewSection(
  patch: string,
  targetNewLine?: number,
): DiffPreviewSection | null {
  const hunks = parseHunks(patch);
  if (hunks.length === 0) return null;

  const matchIndex =
    targetNewLine === undefined
      ? -1
      : hunks.findIndex(
          (hunk) =>
            targetNewLine >= hunk.newStartLine &&
            targetNewLine < hunk.newStartLine + hunk.newLineCount,
        );
  const selected = hunks[matchIndex === -1 ? 0 : matchIndex];
  if (!selected) return null;

  const targetIndex =
    matchIndex === -1 || targetNewLine === undefined
      ? undefined
      : indexOfNewLine(selected, targetNewLine);

  return {
    bodyLines: selected.bodyLines,
    containsTarget: matchIndex !== -1,
    newStartLine: selected.newStartLine,
    ...(targetIndex === undefined ? {} : { targetIndex }),
    totalSections: hunks.length,
  };
}

/**
 * Trims a section to `maxLines`, keeping the hovered line in view instead of
 * always taking the opening lines. Returns the kept lines and whether content
 * was dropped before or after them.
 */
export function windowAroundTarget(
  bodyLines: readonly string[],
  maxLines: number,
  targetIndex?: number,
): {
  readonly lines: readonly string[];
  readonly trimmedEnd: boolean;
  readonly trimmedStart: boolean;
} {
  if (bodyLines.length <= maxLines) {
    return { lines: bodyLines, trimmedEnd: false, trimmedStart: false };
  }
  const anchor = targetIndex ?? 0;
  const half = Math.floor(maxLines / 2);
  const start = Math.min(Math.max(0, anchor - half), bodyLines.length - maxLines);
  return {
    lines: bodyLines.slice(start, start + maxLines),
    trimmedEnd: start + maxLines < bodyLines.length,
    trimmedStart: start > 0,
  };
}

function parseHunks(patch: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | undefined;

  for (const raw of patch.replaceAll("\r", "").split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      const startText = header[1];
      if (startText === undefined) continue;
      const newStartLine = Number.parseInt(startText, 10);
      const newLineCount = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
      if (!Number.isSafeInteger(newStartLine) || !Number.isSafeInteger(newLineCount)) continue;
      current = { bodyLines: [], newLineCount, newStartLine };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    // A following file's header ends the current hunk.
    if (raw.startsWith("diff --git")) {
      current = undefined;
      continue;
    }
    // Keep only diff body lines; drop the no-trailing-newline marker.
    if (raw.startsWith(" ") || raw.startsWith("+") || raw.startsWith("-")) {
      current.bodyLines.push(raw);
    }
  }

  return hunks.filter((hunk) => hunk.bodyLines.length > 0);
}

/** Walks the hunk counting new-file lines to locate the hovered line. */
function indexOfNewLine(hunk: ParsedHunk, targetNewLine: number): number | undefined {
  let newLine = hunk.newStartLine;
  for (const [index, line] of hunk.bodyLines.entries()) {
    if (line.startsWith("-")) continue;
    if (newLine === targetNewLine) return index;
    newLine += 1;
  }
  return undefined;
}
