import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const DAY_MS = 86_400_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_HITS_PER_SESSION = 3;
const SNIPPET_BEFORE = 100;
const SNIPPET_AFTER = 300;
const TRANSCRIPT_ENTRY: EntryLimits = { bytes: 12_000, lines: 200, hint: "read entry {id} for the rest" };
const SINGLE_ENTRY: EntryLimits = { bytes: 46_000, lines: 1500, hint: "entry cut at the tool size limit" };
const TOOL_RESULT_ENTRY: EntryLimits = { bytes: 16_000, lines: 400, hint: "read this entry alone for the rest" };
const UNLIMITED: EntryLimits = { bytes: Infinity, lines: Infinity, hint: "" };
const MAX_HEADER_BYTES = 1024 * 1024;
const FILENAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.jsonl$/;

/** `calls` shows full tool-call arguments but no results; `full` adds results. */
export type ToolsMode = "none" | "stubs" | "calls" | "full";

export interface SessionFile {
  path: string;
  id: string;
  dir: string;
  startedAt: number;
}

export interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  // oxlint-disable-next-line typescript/no-explicit-any -- session JSON is untyped
  [key: string]: any;
}

export interface ParsedSession {
  cwd?: string | undefined;
  name?: string | undefined;
  startedAt?: string | undefined;
  branch: SessionEntry[];
}

export interface SearchHit {
  /** Further matching entries in the same session that are not listed (set on its last hit). */
  moreInSession: number;
  sessionId: string;
  cwd?: string | undefined;
  name?: string | undefined;
  entryId: string;
  time: string;
  snippet: string;
}

/** Parses an ISO date or a relative "Nd" (N days ago). A bare date for `until` includes that whole day. */
export function parseWhen(input: string, now: number, inclusiveDay = false): number {
  const relative = /^(\d+)d$/.exec(input);
  const parsed = relative ? now - Number(relative[1]) * DAY_MS : Date.parse(input);
  if (Number.isNaN(new Date(parsed).getTime()))
    throw new Error(`Invalid date "${input}". Use YYYY-MM-DD, an ISO timestamp, or "30d".`);
  if (relative) return parsed;
  return inclusiveDay && /^\d{4}-\d{2}-\d{2}$/.test(input) ? parsed + DAY_MS : parsed;
}

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}`;
}

/**
 * Directories whose sessions belong to `cwd`: the directory itself, plus the repo's sibling
 * `<repo>.worktrees/` directory (see git-workflow), even when `cwd` is inside one of its worktrees.
 */
export function searchRoots(cwd: string): [string, string] {
  const resolved = resolve(cwd);
  const base = /^(.*?)\.worktrees(?:\/|$)/.exec(resolved)?.[1] ?? resolved;
  return [base, `${base}.worktrees`];
}

async function readHeaderCwd(path: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8", end: MAX_HEADER_BYTES }) });
  try {
    for await (const first of lines) {
      const cwd: unknown = JSON.parse(first)?.cwd;
      return typeof cwd === "string" ? cwd : undefined;
    }
  } catch {
    // Unreadable or malformed header: treat as no cwd.
  } finally {
    lines.close();
  }
  return undefined;
}

/** Lists session files, newest first. `cwd` matches that directory and its subdirectories. */
export async function listSessionFiles(
  root: string,
  options: { cwd?: string | undefined; since?: number | undefined; until?: number | undefined },
): Promise<SessionFile[]> {
  const roots = options.cwd === undefined ? undefined : searchRoots(options.cwd);
  const prefix = roots === undefined ? undefined : encodeCwd(roots[0]!);
  const dirs = (await readdir(root).catch(() => [])).filter((dir) => prefix === undefined || dir.startsWith(prefix));
  const perDir = await Promise.all(
    dirs.map(async (dir) => {
      const names = await readdir(join(root, dir)).catch(() => []);
      return names.flatMap((name) => {
        const match = FILENAME.exec(name);
        if (!match) return [];
        const [, date, hh, mm, ss, ms, id] = match;
        const startedAt = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
        return Number.isNaN(startedAt) || startedAt >= (options.until ?? Infinity)
          ? []
          : [{ path: join(root, dir, name), id: id!, dir, startedAt }];
      });
    }),
  );
  const sorted = perDir.flat().toSorted((a, b) => b.startedAt - a.startedAt);
  // Directory names are a lossy encoding of the cwd, so confirm against the session header.
  const inCwd = await Promise.all(
    sorted.map(async (file) => {
      if (roots === undefined) return true;
      const cwd = await readHeaderCwd(file.path);
      return cwd !== undefined && roots.some((root) => cwd === root || cwd.startsWith(root + sep));
    }),
  );
  const candidates = sorted.filter((_, index) => inCwd[index]);
  if (options.since === undefined) return candidates;
  const since = options.since;
  // A session resumed after `since` still counts, so compare modification time, not creation time.
  const recent = await Promise.all(
    candidates.map(async (file) => ((await stat(file.path).catch(() => undefined))?.mtimeMs ?? 0) >= since),
  );
  return candidates.filter((_, index) => recent[index]);
}

/** Matches a path or ID exactly, else by ID prefix. An empty reference matches nothing. */
export function matchSessions(files: SessionFile[], reference: string): SessionFile[] {
  if (reference.trim() === "") return [];
  const exact = files.filter((file) => file.path === reference || file.id === reference);
  return exact.length > 0 ? exact : files.filter((file) => file.id.startsWith(reference));
}

/** Parses a session file into its header info and the active branch (root to latest leaf). */
export function parseSession(text: string): ParsedSession {
  const entries = text.split("\n").flatMap((line): SessionEntry[] => {
    try {
      const parsed: unknown = line.trim() ? JSON.parse(line) : undefined;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as SessionEntry] : [];
    } catch {
      return [];
    }
  });
  const header = entries.find((entry) => entry.type === "session");
  const byId = new Map(entries.flatMap((entry) => (entry.id === undefined ? [] : [[entry.id, entry] as const])));
  const leaf = entries.findLast((entry) => entry.id !== undefined);
  const branch: SessionEntry[] = [];
  const seen = new Set<SessionEntry>();
  for (
    let current = leaf;
    current && !seen.has(current);
    current = current.parentId ? byId.get(current.parentId) : undefined
  ) {
    seen.add(current);
    branch.push(current);
  }
  branch.reverse();
  const name = branch.findLast((entry) => entry.type === "session_info")?.name;
  return {
    cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
    name: typeof name === "string" ? name : undefined,
    startedAt: header?.timestamp,
    branch,
  };
}

/** Collapses whitespace so untrusted metadata cannot add lines. */
export const oneLine = (value: string, max = 200) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? block.text : block?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

export interface EntryLimits {
  bytes: number;
  lines: number;
  /** Text after "truncated; "; `{id}` becomes the entry ID. */
  hint: string;
}

function truncate(text: string, limits: EntryLimits, entryId: string | undefined): string {
  const lines = text.split("\n");
  if (Buffer.byteLength(text, "utf8") <= limits.bytes && lines.length <= limits.lines) return text;
  const kept = Buffer.from(lines.slice(0, limits.lines).join("\n"), "utf8")
    .subarray(0, limits.bytes)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  return `${kept}\n… [truncated; ${limits.hint.replace("{id}", entryId ?? "?")}]`;
}

/** Renders a value as unescaped text: strings as-is, arrays and objects recursively as `key=value`. */
function plain(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plain).join(" | ");
  if (value !== null && typeof value === "object")
    return Object.entries(value)
      .map(([key, inner]) => `${key}=${plain(inner)}`)
      .join(" ");
  return JSON.stringify(value) ?? "";
}

/** Readable call arguments: the command for bash, `key=value` pairs otherwise. */
function callArgs(call: { name: string; arguments?: unknown }): string {
  const args = call.arguments;
  return call.name === "bash" && typeof (args as { command?: unknown })?.command === "string"
    ? (args as { command: string }).command
    : plain(args ?? {});
}

function toolStub(call: { name: string; arguments?: unknown }): string {
  const args = oneLine(callArgs(call), 200);
  return `[tool ${call.name}: ${args}]`;
}

/** Renders one entry as `{ label, text }`, or undefined when the entry has nothing to show. */
export function renderEntry(
  entry: SessionEntry,
  tools: ToolsMode,
  limits: EntryLimits,
): { label: string; text: string } | undefined {
  const finish = (label: string, text: string) =>
    text.trim() ? { label, text: truncate(text.trim(), limits, entry.id) } : undefined;
  if (entry.type === "compaction" || entry.type === "branch_summary")
    return finish("summary", typeof entry.summary === "string" ? entry.summary : "");
  // Extension-injected notes, such as subagent and background shell results, read like a user turn.
  if (entry.type === "custom_message" && entry.display !== false)
    return finish(`note:${oneLine(String(entry.customType ?? "?"), 40)}`, textOf(entry.content));
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  if (message?.role === "bashExecution") {
    const output = tools === "full" ? `\n${typeof message.output === "string" ? message.output : ""}` : "";
    return finish("user bash", `$ ${message.command}${output}`);
  }
  if (message?.role === "user") return finish("user", textOf(message.content));
  if (message?.role === "assistant") {
    const calls = Array.isArray(message.content)
      ? message.content.filter((block: { type?: string }) => block?.type === "toolCall")
      : [];
    const callText =
      tools === "none"
        ? []
        : calls.map((call: { name: string; arguments?: unknown }) =>
            tools === "full" || tools === "calls" ? `[tool ${call.name}] ${callArgs(call)}` : toolStub(call),
          );
    return finish("assistant", [textOf(message.content), ...callText].filter(Boolean).join("\n"));
  }
  if (message?.role === "toolResult") {
    if (tools === "none" || tools === "calls" || (tools === "stubs" && !message.isError)) return undefined;
    const prefix = `[${message.isError ? "tool error" : "tool result"} ${message.toolName}]`;
    return finish("tool", `${prefix}\n${textOf(message.content)}`);
  }
  return undefined;
}

const stamp = (entry: SessionEntry) =>
  oneLine(
    String(entry.timestamp ?? "?")
      .slice(0, 16)
      .replace("T", " "),
    16,
  );

function formatEntry(entry: SessionEntry, rendered: { label: string; text: string }): string {
  return `**${rendered.label}** · ${stamp(entry)} · \`${oneLine(String(entry.id ?? "?"))}\`\n\n${rendered.text}`;
}

const matchesAll = (text: string | undefined, terms: string[]) =>
  text !== undefined && terms.every((term) => text.toLowerCase().includes(term));

/** Windows the text around the terms: one window when they sit close together, else one per term (up to 3). */
function snippetAround(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  const found = terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0);
  const first = Math.min(...found);
  const last = Math.max(...found);
  const window = (at: number, before: number, after: number) => {
    const start = Math.max(0, at - before);
    const end = at + after;
    return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${flat.length > end ? "…" : ""}`;
  };
  if (found.length === 0) return window(0, 0, SNIPPET_AFTER);
  if (last - first <= SNIPPET_AFTER - 100) return window(first, SNIPPET_BEFORE, last - first + 100 + SNIPPET_BEFORE);
  return [...new Set(found)]
    .toSorted((a, b) => a - b)
    .slice(0, 3)
    .map((at) => window(at, 40, 140))
    .join(" ");
}

/** Finds entries containing every term (case-insensitive), at most a few per session, newest session first. */
export async function searchSessions(
  files: SessionFile[],
  terms: string[],
  options: {
    limit: number;
    signal?: AbortSignal | undefined;
    /** `calls` (default) skips tool outputs; `full` includes them. */
    mode?: ToolsMode | undefined;
    /** The running session: only the part compacted away is searched, since the rest is already in context. */
    currentPath?: string | undefined;
  },
): Promise<{ hits: SearchHit[]; skipped: number; stoppedAtLimit: boolean }> {
  const { limit, signal, mode = "calls", currentPath } = options;
  const hits: SearchHit[] = [];
  let skipped = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    if (hits.length >= limit) return { hits, skipped, stoppedAtLimit: true };
    if (((await stat(file.path).catch(() => undefined))?.size ?? 0) > MAX_FILE_BYTES) {
      skipped += 1;
      continue;
    }
    const raw = await readFile(file.path, { encoding: "utf8", signal }).catch(() => "");
    const lower = raw.toLowerCase();
    // Cheap whole-file check first so only plausible sessions get parsed.
    // Terms are compared against the raw JSON, so escape them the way JSON.stringify did.
    if (!terms.every((term) => lower.includes(JSON.stringify(term).slice(1, -1)))) continue;
    const session = parseSession(raw);
    const searchable =
      file.path === currentPath
        ? session.branch.slice(
            0,
            Math.max(
              0,
              session.branch.findLastIndex((entry) => entry.type === "compaction"),
            ),
          )
        : session.branch;
    const matches = searchable
      .flatMap((entry) => {
        const rendered = renderEntry(entry, mode, UNLIMITED);
        const haystack = rendered?.text.toLowerCase();
        return rendered && haystack && terms.every((term) => haystack.includes(term))
          ? [{ entry, rendered, prose: matchesAll(renderEntry(entry, "none", UNLIMITED)?.text, terms) }]
          : [];
      })
      // Prose beats tool-call arguments; order is otherwise chronological.
      .toSorted((a, b) => Number(b.prose) - Number(a.prose));
    const shown = matches.slice(0, Math.min(MAX_HITS_PER_SESSION, limit - hits.length));
    shown.forEach(({ entry, rendered }, index) =>
      hits.push({
        moreInSession: index === shown.length - 1 ? matches.length - shown.length : 0,
        sessionId: file.id,
        cwd: session.cwd,
        name: session.name,
        entryId: oneLine(String(entry.id ?? "?")),
        time: stamp(entry),
        snippet: `${rendered.label}: ${snippetAround(rendered.text, terms)}`,
      }),
    );
  }
  return { hits, skipped, stoppedAtLimit: false };
}

/** Renders a session as a markdown transcript page, or a single entry in full. */
export async function readSession(
  file: SessionFile,
  options: {
    signal?: AbortSignal | undefined;
    from?: string | undefined;
    entry?: string | undefined;
    tools: ToolsMode;
    maxBytes: number;
    maxLines: number;
  },
): Promise<string> {
  if ((await stat(file.path)).size > MAX_FILE_BYTES) throw new Error("Session file is too large to read.");
  const session = parseSession(await readFile(file.path, { encoding: "utf8", signal: options.signal }));
  const title = `# ${oneLine(session.name ?? file.id)}\n${oneLine(session.cwd ?? "?")} · started ${oneLine(session.startedAt ?? "?")} · session ${oneLine(file.id)}`;

  if (options.entry !== undefined) {
    const entry = session.branch.find((candidate) => candidate.id === options.entry);
    const rendered = entry && renderEntry(entry, "full", SINGLE_ENTRY);
    if (!entry || !rendered) return `${title}\n\nEntry ${options.entry} not found on the active branch.`;
    // An assistant turn's tool results are what the reader usually wants next.
    const callIds = new Set<unknown>(
      (Array.isArray(entry.message?.content) ? entry.message.content : [])
        .filter((block: { type?: string }) => block?.type === "toolCall")
        .map((block: { id?: unknown }) => block.id),
    );
    const results = session.branch.flatMap((candidate) => {
      const result = callIds.has(candidate.message?.toolCallId) && renderEntry(candidate, "full", TOOL_RESULT_ENTRY);
      return result ? [formatEntry(candidate, result)] : [];
    });
    return [title, formatEntry(entry, rendered), ...results].join("\n\n");
  }

  const blocks = session.branch.flatMap((entry, position) => {
    const rendered = renderEntry(entry, options.tools, TRANSCRIPT_ENTRY);
    return rendered ? [{ id: entry.id, position, text: formatEntry(entry, rendered) }] : [];
  });
  // `from` may name an entry hidden at this detail level (e.g. a successful tool result): start at the next visible one.
  const fromPosition = options.from === undefined ? 0 : session.branch.findIndex((entry) => entry.id === options.from);
  const startIndex =
    options.from === undefined
      ? 0
      : fromPosition < 0
        ? -1
        : blocks.findIndex((block) => block.position >= fromPosition);
  if (startIndex < 0)
    return `${title}\n\nEntry ${options.from} not found on the active branch, or nothing visible follows it.`;

  const page: string[] = [];
  let bytes = 0;
  let lines = 0;
  for (const block of blocks.slice(startIndex)) {
    // Each block is joined with a blank line.
    const blockBytes = Buffer.byteLength(block.text, "utf8") + 2;
    const blockLines = block.text.split("\n").length + 1;
    if (page.length > 0 && (bytes + blockBytes > options.maxBytes || lines + blockLines > options.maxLines)) break;
    page.push(block.text);
    bytes += blockBytes;
    lines += blockLines;
  }
  const next = blocks[startIndex + page.length];
  const footer = next ? `\n\n---\nMore content: call again with from="${oneLine(String(next.id))}".` : "";
  return `${title}\n\n${page.join("\n\n")}${footer}`;
}
