import assert from "node:assert/strict";
import test from "node:test";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { createPalette, decorate, toneOf, type ThemeLike } from "../emphasis.ts";

// A theme whose colors are readable tags, so tests can assert on what was colored.
const theme: ThemeLike = {
  fg: (color, text) => `<${color}>${text}</>`,
  getFgAnsi: (color) => `\x1b[38;fg-${color}m`,
  getBgAnsi: (color) => `\x1b[48;bg-${color}m`,
};
const palette = createPalette(theme);
const plain = (text: string) =>
  decorate(text, palette)
    .replace(/\x1b\[[0-9;a-zA-Z-]*m/g, "")
    .replace(/[\ue0b4\ue0b6]/g, "|")
    .replace(/\u00a0/g, " ");

test("pill tones classify core words, case, spacing, and detail", () => {
  const cases = [
    ["Failed", "error"],
    ["Blocked", "error"],
    ["Needs you", "warning"],
    ["Decision", "warning"],
    ["Done", "success"],
    ["Observed", "success"],
    ["Costs money", "danger"],
    ["Irreversible", "danger"],
    ["Implement", "mode"],
    ["Shared", "owner"],
    ["Inferred", "neutral"],
    ["Anything else", "neutral"],
    ["  needs   YOU ", "warning"],
    ["Passed 12/12", "success"],
    ["Failed: 3 tests", "error"],
    ["Donezo", "neutral"],
  ] as const;

  for (const [word, expected] of cases) {
    assert.equal(toneOf(word), expected, word);
  }
});

test("pills render icons, synonyms, custom glyphs, and length bounds", () => {
  assert.equal(plain("[[Done]]"), "|\uf00c Done|");
  assert.equal(plain("[[Anything else]]"), "|Anything else|");
  assert.equal(plain("[[Completed]]"), "|\uf00c Done|");
  assert.equal(plain("[[Fail: 3 tests]]"), "|\uf00d Failed: 3 tests|");
  assert.equal(plain("[[\uf0e7 Done]]"), "|\uf0e7 Done|");

  const long = `[[${"x".repeat(33)}]]`;
  assert.equal(plain(long), long);
});

test("headings render pills, label icons, and inline code cleanly", () => {
  assert.equal(plain("## Finding"), "## \uf002 Finding");
  assert.equal(plain("## What happened"), "## What happened");
  assert.equal(
    plain(" ### Two caveats in the current extension code [[Observed]]"),
    " ### Two caveats in the current extension code |\uf06e Observed|",
  );
  assert.equal(plain("## Finding [[Observed]]"), "## \uf002 Finding |\uf06e Observed|");
  assert.equal(plain("### Why `[[Observed]]` failed [[Fixed]]"), "### Why `[[Observed]]` failed |\uf0ad Fixed|");
});

test("Markdown component preserves heading styling after a pill and keeps H1 pills un-underlined", () => {
  const ansiTheme: ThemeLike = {
    fg: (_color, text) => `\x1b[38;2;10;20;30m${text}\x1b[39m`,
    getFgAnsi: (color) => (color === "mdHeading" ? "\x1b[38;2;239;159;118m" : "\x1b[38;2;166;209;137m"),
    getBgAnsi: () => "\x1b[48;2;40;60;40m",
  };
  const identity = (text: string) => text;
  const mdTheme: MarkdownTheme = {
    heading: (text) => `\x1b[38;2;239;159;118m${text}\x1b[39m`,
    link: identity,
    linkUrl: identity,
    code: (text) => `\x1b[36m${text}\x1b[39m`,
    codeBlock: identity,
    codeBlockBorder: identity,
    quote: identity,
    quoteBorder: identity,
    hr: identity,
    listBullet: identity,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    italic: identity,
    strikethrough: identity,
    underline: (text) => `\x1b[4m${text}\x1b[24m`,
  };

  const decorated = decorate(
    "# Release [[Draft]] plan\n\n ### [[Observed]] Two caveats in `index.ts`",
    createPalette(ansiTheme),
  );
  const lines = new Markdown(decorated, 0, 0, mdTheme)
    .render(120)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  assert.equal(lines.length, 2);
  // H1 disables underline before the pill and restores heading color + bold + underline for " plan".
  assert.match(lines[0] ?? "", /\x1b\[24;39m.*\uf044\u00a0Draft.*\x1b\[38;2;239;159;118m\x1b\[1m\x1b\[4m plan/);
  // H3 restores heading color + bold for " Two caveats in " after the pill and leaves inline code intact.
  assert.match(lines[1] ?? "", /\uf06e\u00a0Observed.*\x1b\[38;2;239;159;118m\x1b\[1m Two caveats in .*index\.ts/);
});

test("leading bold labels and action lead-ins receive icons", () => {
  assert.equal(plain("**Cause:** x"), "**<mdLink>\uf0e7 Cause:</>** x");
  assert.equal(plain("- **Fix:** x"), "- **<mdLink>\uf0ad Fix:</>** x");
  assert.equal(plain("  ├── **Risk:** x"), "  <dim>├──</> **<mdLink>\uf071 Risk:</>** x");
  assert.equal(plain("see **Cause** here"), "see **<mdLink>Cause</>** here");
  assert.equal(
    plain("[[Unverified]] red pills. **Check:** run it"),
    "|\uf128 Unverified| red pills. **<mdLink>\uf046 Check:</>** run it",
  );
  assert.equal(plain("**Next:** go"), "**<mdLink>\uf061 Next:</>** go");
  assert.equal(plain("please **do** it and **run** that"), "please **<mdLink>do</>** it and **<mdLink>run</>** that");
});

test("fenced code, inline code, and escaped markers stay untouched", () => {
  const block = "```\n**Cause:** → [[Done]]\n```";
  assert.equal(plain(block), block);
  assert.equal(plain("`[[Done]] → **x**`"), "`[[Done]] → **x**`");
  assert.equal(plain("\\*\\*not bold\\*\\*"), "\\*\\*not bold\\*\\*");
});

test("arrows, checks, crosses, and icon toggle work", () => {
  assert.equal(plain("a → b ✓ c ✗"), "a <accent>→</> b <success>✓</> c <error>✗</>");

  process.env.PI_EMPHASIS_PILL_ICONS = "0";
  try {
    assert.equal(plain("[[Done]]"), "|Done|");
    assert.equal(plain("## Finding"), "## Finding");
  } finally {
    delete process.env.PI_EMPHASIS_PILL_ICONS;
  }
});
