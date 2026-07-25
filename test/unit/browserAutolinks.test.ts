import assert from "node:assert/strict";

import {
  BROWSER_AUTOLINK_COMMANDS,
  escapeMarkdownWithAutolinks,
} from "../../src/ui/browserAutolinks";

const ROOT = "C:\\repo";

suite("reference autolinks", () => {
  test("declares exactly the reference-opening command", () => {
    assert.deepEqual(BROWSER_AUTOLINK_COMMANDS, ["refhaven.openBrowserReference"]);
  });

  test("linkifies issue and merge request shorthand with validated arguments", () => {
    const rendered = escapeMarkdownWithAutolinks("fix #12 via !345", ROOT);

    const links = [
      ...rendered.matchAll(/\[([^\]]+)\]\(command:refhaven\.openBrowserReference\?([^)\s]+)\)/gu),
    ];
    assert.equal(links.length, 2);
    assert.deepEqual(JSON.parse(decodeURIComponent(links[0]?.[2] ?? "")), [ROOT, "#12"]);
    assert.deepEqual(JSON.parse(decodeURIComponent(links[1]?.[2] ?? "")), [ROOT, "!345"]);
    assert.equal(links[0]?.[1], "\\#12");
    assert.equal(links[1]?.[1], "\\!345");
  });

  test("keeps non-reference text escaped and unlinked", () => {
    for (const text of [
      "a#1 inline word boundary",
      "#0 leading zero",
      "!012 zero-padded",
      "path/#12 after slash",
      "&#38; entity",
      "sha #12abc word suffix",
      "café#12 unicode word boundary",
      "修正!12 unicode word boundary",
      "##12 double sigil",
      "#!12 mixed sigils",
    ]) {
      const rendered = escapeMarkdownWithAutolinks(text, ROOT);
      assert.doesNotMatch(rendered, /command:/u, text);
    }
  });

  test("linkifies references at boundaries and keeps surroundings escaped", () => {
    const rendered = escapeMarkdownWithAutolinks("#7 (see: [docs] #8, !9.)", ROOT);

    assert.equal([...rendered.matchAll(/command:/gu)].length, 3);
    assert.match(rendered, /^\[\\#7\]/u);
    assert.match(rendered, /\\\[docs\\\]/u);
  });

  test("percent-encodes parentheses so links survive markdown rendering", () => {
    const rendered = escapeMarkdownWithAutolinks("#12", "C:\\repos (work)\\app");

    const query = /command:refhaven\.openBrowserReference\?([^)\s]+)\)/u.exec(rendered)?.[1] ?? "";
    assert.doesNotMatch(query, /[()]/u);
    assert.deepEqual(JSON.parse(decodeURIComponent(query)), ["C:\\repos (work)\\app", "#12"]);
  });

  test("neutralizes markdown injection around references", () => {
    const rendered = escapeMarkdownWithAutolinks("[click](evil) #12 **bold**", ROOT);

    assert.match(rendered, /\\\[click\\\]\\\(evil\\\)/u);
    assert.match(rendered, /\\\*\\\*bold\\\*\\\*/u);
    assert.equal([...rendered.matchAll(/command:/gu)].length, 1);
  });
});
