const MARKDOWN_CHARACTERS = new Set("\\`*_{}[]()<>#+-.!|");

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
