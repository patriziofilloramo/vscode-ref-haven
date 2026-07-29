const UNSUPPORTED_CONTENT_FILTER_MESSAGE =
  "Working-tree Git operations are unavailable for files with an active content filter. RefHaven will not return an approximation.";

export class UnsupportedContentFilterError extends Error {
  public constructor() {
    super(UNSUPPORTED_CONTENT_FILTER_MESSAGE);
    this.name = "UnsupportedContentFilterError";
  }
}

/** Strict parser for the NUL-delimited output of `git check-attr`. */
export function assertInactiveContentFilterOutput(
  output: string,
  expectedPaths: readonly string[],
): void {
  const expected = new Set(expectedPaths);
  if (expected.size !== expectedPaths.length || expected.size === 0 || !output.endsWith("\0")) {
    throw new UnsupportedContentFilterError();
  }

  const fields = output.slice(0, -1).split("\0");
  if (fields.length !== expected.size * 3) throw new UnsupportedContentFilterError();

  const seen = new Set<string>();
  for (let index = 0; index < fields.length; index += 3) {
    const filePath = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (
      filePath === undefined ||
      attribute !== "filter" ||
      value === undefined ||
      !expected.has(filePath) ||
      seen.has(filePath) ||
      (value !== "unspecified" && value !== "unset")
    ) {
      throw new UnsupportedContentFilterError();
    }
    seen.add(filePath);
  }
  if (seen.size !== expected.size) throw new UnsupportedContentFilterError();
}
