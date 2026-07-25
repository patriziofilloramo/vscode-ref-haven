import { COMMAND_IDS } from "./commands/commandIds";
import { encodeCommandArguments, escapeMarkdown } from "./markdown";

/** Commands a MarkdownString must trust for autolinked references to work. */
export const BROWSER_AUTOLINK_COMMANDS: readonly string[] = [COMMAND_IDS.openBrowserReference];

/**
 * Matches `#123` (issue) and `!123` (merge request) shorthand references.
 * A reference must start the text or follow a non-word boundary character,
 * and must not be followed by more word characters, so SHAs, paths, and
 * shell fragments such as `a#1` or `#123abc` never linkify.
 */
const REFERENCE_PATTERN =
  /(^|[^\p{L}\p{M}\p{N}_#!/&])([#!])([1-9]\d{0,9})(?![\p{L}\p{M}\p{N}_#!])/gu;

/**
 * Escapes commit-controlled text for a trusted MarkdownString while turning
 * GitLab issue/merge-request shorthand into command links. The command only
 * receives the repository root and the reference text; opening still runs
 * through the approved-origin allowlist, so rendering a link performs no
 * network activity and cannot leave the approved boundary when clicked.
 */
export function escapeMarkdownWithAutolinks(text: string, repositoryRoot: string): string {
  let rendered = "";
  let consumed = 0;
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const [, prefix = "", sigil, digits] = match;
    if (sigil === undefined || digits === undefined) continue;
    const reference = `${sigil}${digits}`;
    rendered += escapeMarkdown(text.slice(consumed, match.index) + prefix);
    rendered += `[${escapeMarkdown(reference)}](command:${COMMAND_IDS.openBrowserReference}?${encodeCommandArguments([repositoryRoot, reference])})`;
    consumed = match.index + prefix.length + reference.length;
  }
  return rendered + escapeMarkdown(text.slice(consumed));
}
