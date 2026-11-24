// Vendored from github.com/johnlindquist/pi-emphasis (MIT License, Copyright (c) 2026 John Lindquist).
// Display-only emphasis for assistant replies in Pi's terminal; stored messages, copied text, and HTML exports keep raw Markdown.
import type { ExtensionAPI, ThemeBg, ThemeColor } from "@earendil-works/pi-coding-agent";

type Colorize = (text: string) => string;
export type PillTone = "success" | "error" | "warning" | "danger" | "mode" | "owner" | "neutral";

export interface Palette {
  bold: Colorize;
  /** Opening foreground escape for Markdown headings, restored after inline pills or marks in headings. */
  heading?: string;
  passed?: Colorize;
  failed?: Colorize;
  pills?: Record<PillTone, { label: string; cap: string }>;
  arrow?: Colorize;
  tree?: Colorize;
  /** Rounded Nerd Font end caps; false draws square chips padded with spaces. */
  roundCaps?: boolean;
}

export interface ThemeLike {
  fg(color: ThemeColor, text: string): string;
  getFgAnsi(color: ThemeColor): string;
  getBgAnsi(color: ThemeBg): string;
}

export default function emphasisExtension(pi: ExtensionAPI): void {
  let currentTheme: (() => ThemeLike) | undefined;
  let built: { theme: ThemeLike; palette: Palette } | undefined;

  pi.on("session_start", (_event, ctx) => {
    currentTheme = ctx.mode === "tui" ? () => ctx.ui.theme : undefined;
    built = undefined;
  });

  pi.on("session_shutdown", () => {
    currentTheme = undefined;
    built = undefined;
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (!currentTheme || context.messageType !== "assistant") return markdown;
    const theme = currentTheme();
    if (built?.theme !== theme) {
      built = { theme, palette: createPalette(theme) };
    }
    return decorate(markdown, built.palette);
  });
}

/** Apply colors, icons, and pills to assistant Markdown while leaving code blocks and inline code intact. */
export function decorate(markdown: string, palette: Palette): string {
  const [open = "", close = ""] = palette.bold("\u0000").split("\u0000");
  return markdown
    .split("\n")
    .reduce<{ lines: string[]; fence: string | undefined }>(
      (state, line) => {
        const fenceMarker = line.match(FENCE)?.[1];
        if (state.fence) {
          const closesFence =
            fenceMarker !== undefined && fenceMarker[0] === state.fence[0] && fenceMarker.length >= state.fence.length;
          return { lines: [...state.lines, line], fence: closesFence ? undefined : state.fence };
        }
        if (fenceMarker) return { lines: [...state.lines, line], fence: fenceMarker };
        const headingMatch = line.match(HEADING);
        if (headingMatch) {
          const [, indent = "", hashes = "", space = " ", title = ""] = headingMatch;
          return {
            lines: [...state.lines, `${indent}${hashes}${space}${decorateHeadingTitle(title, hashes.length, palette)}`],
            fence: undefined,
          };
        }
        return { lines: [...state.lines, decorateLine(line, palette, open, close)], fence: undefined };
      },
      { lines: [], fence: undefined },
    )
    .lines.join("\n");
}

export function createPalette(theme: ThemeLike, boldColor: ThemeColor = "mdLink"): Palette {
  const fg = (name: ThemeColor) => (text: string) => theme.fg(name, text);
  const tone = (labelFg: ThemeColor, bg: ThemeBg) => {
    const bgAnsi = theme.getBgAnsi(bg);
    // System themes without panel backgrounds fall back to reverse video so pills stay legible.
    if (!bgAnsi || /^\x1b\[49m$/.test(bgAnsi)) {
      const fgAnsi = theme.getFgAnsi(labelFg === "text" ? "accent" : labelFg);
      return { label: `${fgAnsi}\x1b[7m`, cap: fgAnsi };
    }
    return { label: bgAnsi + theme.getFgAnsi(labelFg), cap: bgToFg(bgAnsi) };
  };
  return {
    bold: fg(boldColor),
    heading: theme.getFgAnsi("mdHeading"),
    passed: fg("success"),
    failed: fg("error"),
    pills: {
      success: tone("success", "toolSuccessBg"),
      error: tone("error", "toolErrorBg"),
      warning: tone("warning", "searchMatchBg"),
      neutral: tone("text", "selectedBg"),
      danger: solid(31),
      mode: solid(36),
      owner: solid(34),
    },
    arrow: fg("accent"),
    tree: fg("dim"),
    roundCaps: process.env.PI_EMPHASIS_ROUND_CAPS !== "0",
  };
}

export function toneOf(label: string): PillTone {
  const { key } = splitLabel(label);
  return TONE_ORDER.find((tone) => TONE_WORDS[tone].includes(key)) ?? "neutral";
}

const TONE_ORDER = ["danger", "error", "warning", "success", "mode", "owner"] as const;
const TONE_WORDS = {
  danger: ["costs money", "destructive", "irreversible"],
  error: ["failed", "blocked", "broken", "unsafe", "fail", "failing", "error", "rejected", "down"],
  warning: [
    "needs you",
    "decision",
    "unverified",
    "partial",
    "skipped",
    "in progress",
    "pending",
    "at risk",
    "needs review",
    "waiting",
    "review",
    "todo",
    "stale",
    "draft",
  ],
  success: [
    "done",
    "passed",
    "observed",
    "fixed",
    "live",
    "recommended",
    "keep",
    "pass",
    "ready",
    "merged",
    "safe",
    "verified",
    "shipped",
    "ok",
    "approved",
    "complete",
    "completed",
    "finished",
    "healthy",
  ],
  mode: ["brainstorm", "investigate", "preview", "implement", "qualify"],
  owner: ["owned", "shared", "foreign"],
} satisfies Record<Exclude<PillTone, "neutral">, string[]>;

const CHECK = "\uf00c";
const CROSS = "\uf00d";
const CLOCK = "\uf017";

const PILL_ICONS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    done: CHECK,
    passed: CHECK,
    pass: CHECK,
    complete: CHECK,
    completed: CHECK,
    ok: CHECK,
    verified: CHECK,
    observed: "\uf06e",
    recommended: "\uf005",
    fixed: "\uf0ad",
    live: "\uf135",
    shipped: "\uf135",
    approved: "\uf164",
    failed: CROSS,
    fail: CROSS,
    failing: CROSS,
    error: CROSS,
    rejected: CROSS,
    blocked: "\uf05e",
    broken: "\uf127",
    unsafe: "\uf132",
    down: "\uf063",
    "needs you": "\uf007",
    decision: "\uf126",
    unverified: "\uf128",
    "at risk": "\uf071",
    "in progress": "\uf110",
    pending: CLOCK,
    waiting: CLOCK,
    partial: "\uf042",
    skipped: "\uf04e",
    inferred: "\uf0eb",
    new: "\uf067",
    changed: "\uf040",
    optional: "\uf10c",
    "costs money": "\uf155",
    destructive: "\uf1f8",
    irreversible: "\uf023",
    review: "\uf06e",
    stale: "\uf1da",
    draft: "\uf044",
    safe: "\uf132",
    brainstorm: "\uf0eb",
    investigate: "\uf002",
    preview: "\uf06e",
    implement: "\uf0ad",
    qualify: "\uf0c3",
    owned: "\uf007",
    shared: "\uf0c0",
    foreign: "\uf023",
    keep: "\uf08d",
    ready: CHECK,
    merged: "\uf126",
    healthy: "\uf004",
    todo: "\uf0ae",
  }),
);

const SYNONYMS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    complete: "Done",
    completed: "Done",
    ok: "Done",
    finished: "Done",
    pass: "Passed",
    fail: "Failed",
    failing: "Failed",
    error: "Failed",
    waiting: "Pending",
    "needs review": "Review",
  }),
);

const LABEL_ICONS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    finding: "\uf002",
    terminal: "\uf120",
    folder: "\uf07b",
    file: "\uf15b",
    branch: "\uf126",
    review: "\uf06e",
    ideas: "\uf0eb",
    cause: "\uf0e7",
    fix: "\uf0ad",
    risk: "\uf071",
    limits: "\uf071",
    next: "\uf061",
    rollback: "\uf0e2",
    undo: "\uf0e2",
    options: "\uf0ca",
    result: "\uf11e",
    why: "\uf059",
    how: "\uf013",
    cost: "\uf155",
    rule: "\uf0e3",
    example: "\uf121",
    checked: "\uf00c",
    pills: "\uf02b",
    colors: "\uf1fc",
    icons: "\uf005",
    scoreboard: "\uf080",
    verdict: "\uf0e3",
    effect: "\uf140",
    evidence: "\uf06e",
    plan: "\uf0ae",
    status: "\uf012",
    decision: "\uf126",
  }),
);

const ACTION_ICONS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    check: "\uf046",
    do: "\uf0a4",
    next: "\uf061",
    unblock: "\uf09c",
    left: "\uf141",
    run: "\uf04b",
    guard: "\uf132",
    undo: "\uf0e2",
    see: "\uf08e",
  }),
);
const ACTION_LABEL = new RegExp(`(\\*\\*)(${[...ACTION_ICONS.keys()].join("|")})(:\\*\\*)`, "gi");

// A label that opens with a Private Use Area glyph keeps its own icon over the table's.
const OWN_ICON = /^\s*([\ue000-\uf8ff]|[\u{f0000}-\u{ffffd}])\s*/u;
const KNOWN = [...new Set([...Object.values(TONE_WORDS).flat(), ...PILL_ICONS.keys(), ...SYNONYMS.keys()])].sort(
  (a, b) => b.length - a.length,
);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^( {0,3})(#{1,6})(\s+)(.+)$/;
const PILL = /\[\[([^\[\]\n]{1,32})\]\]/g;
const INLINE = /(\\*)(\*\*|__)|\[\[([^\[\]\n]{1,32})\]\]/g;
const LEAD_LABEL = /^(\s*(?:[-*+]|\d+\.)?\s*(?:[├└]──\s*)?\*\*)([^*`\n]{1,32})(\*\*)/;

function splitLabel(label: string) {
  const own = label.match(OWN_ICON);
  const text = (own ? label.slice(own[0].length) : label).replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const known = KNOWN.find((k) => lower === k || (lower.startsWith(k) && /[ :]/.test(lower[k.length] ?? "")));
  const canonical = known ? SYNONYMS.get(known) : undefined;
  const key = (canonical ?? known ?? lower).toLowerCase();
  const word = canonical && known ? canonical + text.slice(known.length) : text;
  return { icon: own?.[1] ?? PILL_ICONS.get(key), word, key };
}

function bgToFg(bg: string): string {
  return bg
    .replace(/\x1b\[48;/g, "\x1b[38;")
    .replace(/\x1b\[(4|10)([0-7])m/g, (_, p: string, n: string) => `\x1b[${p === "4" ? "3" : "9"}${n}m`);
}

const solid = (code: number) => ({ label: `\x1b[${code}m\x1b[7m`, cap: `\x1b[${code}m` });

function withLabelIcon(label: string): string {
  if (OWN_ICON.test(label) || process.env.PI_EMPHASIS_PILL_ICONS === "0") return label;
  const word = label
    .replace(/[:\s]+$/, "")
    .trim()
    .toLowerCase();
  const icon = LABEL_ICONS.get(word) ?? (label.trimEnd().endsWith(":") ? ACTION_ICONS.get(word) : undefined);
  return icon ? `${icon} ${label}` : label;
}

function pill(label: string, style: { label: string; cap: string }, roundCaps: boolean): string {
  const { icon, word } = splitLabel(label);
  // No-break spaces keep multi-word pills on one line when Pi wraps paragraphs.
  const text = (
    icon && word && process.env.PI_EMPHASIS_PILL_ICONS !== "0" ? `${icon} ${word}` : word || label.trim()
  ).replace(/ /g, "\u00a0");
  const [left, right] = roundCaps ? ["\ue0b6", "\ue0b4"] : ["", ""];
  const pad = roundCaps ? "" : "\u00a0";
  const capL = left ? `${style.cap}${left}\x1b[39m` : "";
  const capR = right ? `${style.cap}${right}\x1b[39m` : "";
  return `${capL}${style.label}\x1b[1m${pad}${text}${pad}\x1b[22;27m\x1b[39m\x1b[49m${capR}`;
}

function colorMarks(text: string, palette: Palette, reopen: string): string {
  let out = text;
  if (palette.passed) out = out.replace(/[✓✔]/g, (m) => `${palette.passed!(m)}${reopen}`);
  if (palette.failed) out = out.replace(/[✗✘]/g, (m) => `${palette.failed!(m)}${reopen}`);
  if (palette.arrow) out = out.replace(/→/g, (m) => `${palette.arrow!(m)}${reopen}`);
  return out;
}

function decorateHeadingTitle(title: string, depth: number, palette: Palette): string {
  const base = title.replace(/(?:\s*\[\[[^\[\]\n]{1,32}\]\])+$/, "");
  const labeled = withLabelIcon(base) + title.slice(base.length);
  const reopen = `${palette.heading ?? ""}\x1b[1m${depth === 1 ? "\x1b[4m" : ""}`;
  // `\x1b[24;39m` disables H1 underline inside the pill without matching chalk.underline's literal `\x1b[24m` hook.
  const beforePill = depth === 1 ? "\x1b[24;39m" : "";
  return labeled
    .split(/(`+[^`]*?`+)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      const prose = colorMarks(part, palette, reopen);
      if (!palette.pills) return prose;
      return prose.replace(PILL, (match, label: string) =>
        label.trim()
          ? `${beforePill}${pill(label, palette.pills![toneOf(label)], palette.roundCaps !== false)}${reopen}`
          : match,
      );
    })
    .join("");
}

function decorateProsePart(
  part: string,
  palette: Palette,
  open: string,
  close: string,
  initialBold: string | undefined,
) {
  let inBold = initialBold;
  let prose = part;
  if (process.env.PI_EMPHASIS_PILL_ICONS !== "0") {
    prose = prose.replace(ACTION_LABEL, (_, before: string, word: string, after: string) => {
      const icon = ACTION_ICONS.get(word.toLowerCase());
      return icon ? `${before}${icon} ${word}${after}` : `${before}${word}${after}`;
    });
  }
  prose = colorMarks(prose, palette, inBold ? open : "");
  if (palette.tree) prose = prose.replace(/[├└]──/g, (m) => palette.tree!(m) + (inBold ? open : ""));
  const text = prose.replace(
    INLINE,
    (match, slashes: string | undefined, marker: string | undefined, label: string | undefined) => {
      if (label !== undefined) {
        if (!palette.pills || !label.trim()) return match;
        return (
          pill(label, palette.pills[toneOf(label)], palette.roundCaps !== false) + (inBold ? `\x1b[1m${open}` : "")
        );
      }
      if ((slashes ?? "").length % 2 === 1) return match;
      if (!inBold) {
        inBold = marker;
        return `${slashes ?? ""}${marker ?? ""}${open}`;
      }
      if (inBold === marker) {
        inBold = undefined;
        return `${slashes ?? ""}${close}${marker ?? ""}`;
      }
      return match;
    },
  );
  return { text, inBold };
}

function decorateLine(line: string, palette: Palette, open: string, close: string): string {
  const parts = line
    .replace(LEAD_LABEL, (_, before: string, label: string, after: string) => before + withLabelIcon(label) + after)
    .split(/(`+[^`]*?`+)/g);
  const final = parts.reduce<{ text: string; inBold: string | undefined }>(
    (state, part, index) => {
      if (index % 2 === 1) {
        // Pi's inline code color ends with a foreground reset; restore surrounding bold color.
        return { text: state.text + (state.inBold ? `${part}${open}` : part), inBold: state.inBold };
      }
      const next = decorateProsePart(part, palette, open, close, state.inBold);
      return { text: state.text + next.text, inBold: next.inBold };
    },
    { text: "", inBold: undefined },
  );
  return final.inBold ? final.text + close : final.text;
}
