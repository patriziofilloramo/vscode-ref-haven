const MARKDOWN_CHARACTERS = new Set("\\`*_{}[]()<>#+-.!|");

/**
 * Encodes command-link arguments for a trusted MarkdownString.
 * encodeURIComponent leaves `(` and `)` unencoded, but an unbalanced `)`
 * inside a Markdown link destination terminates the link early, so both
 * are percent-encoded explicitly.
 */
export function encodeCommandArguments(args: readonly unknown[]): string {
  return encodeURIComponent(JSON.stringify(args)).replaceAll("(", "%28").replaceAll(")", "%29");
}

/** Escapes untrusted text before interpolation into VS Code MarkdownString content. */
export function escapeMarkdown(value: string): string {
  let escaped = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      (code <= 0x1f && character !== "\n" && character !== "\r" && character !== "\t") ||
      code === 0x7f
    ) {
      continue;
    }
    escaped += MARKDOWN_CHARACTERS.has(character) ? `\\${character}` : character;
  }
  return escaped;
}
