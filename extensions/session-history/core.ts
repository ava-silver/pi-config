import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 86_400_000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_HITS_PER_SESSION = 3;
const TRANSCRIPT_ENTRY_CHARS = 4000;
const SINGLE_ENTRY_CHARS = 50_000;
const FILENAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.jsonl$/;

export type ToolsMode = "none" | "stubs" | "full";

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
  if (relative) return now - Number(relative[1]) * DAY_MS;
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) throw new Error(`Invalid date "${input}". Use YYYY-MM-DD, an ISO timestamp, or "30d".`);
  return inclusiveDay && /^\d{4}-\d{2}-\d{2}$/.test(input) ? parsed + DAY_MS : parsed;
}

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}`;
}

/** Lists session files, newest first. `cwd` matches that directory and its subdirectories. */
export async function listSessionFiles(
  root: string,
  options: { cwd?: string | undefined; since?: number | undefined; until?: number | undefined },
): Promise<SessionFile[]> {
  const prefix = options.cwd === undefined ? undefined : encodeCwd(options.cwd);
  const dirs = (await readdir(root).catch(() => [])).filter((dir) => prefix === undefined || dir.startsWith(prefix));
  const perDir = await Promise.all(
    dirs.map(async (dir) => {
      const names = await readdir(join(root, dir)).catch(() => []);
      return names.flatMap((name) => {
        const match = FILENAME.exec(name);
        if (!match) return [];
        const [, date, hh, mm, ss, ms, id] = match;
        const startedAt = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
        return startedAt > (options.until ?? Infinity)
          ? []
          : [{ path: join(root, dir, name), id: id!, dir, startedAt }];
      });
    }),
  );
  const candidates = perDir.flat().toSorted((a, b) => b.startedAt - a.startedAt);
  if (options.since === undefined) return candidates;
  const since = options.since;
  // A session resumed after `since` still counts, so compare modification time, not creation time.
  const recent = await Promise.all(
    candidates.map(async (file) => ((await stat(file.path).catch(() => undefined))?.mtimeMs ?? 0) >= since),
  );
  return candidates.filter((_, index) => recent[index]);
}

/** Parses a session file into its header info and the active branch (root to latest leaf). */
export function parseSession(text: string): ParsedSession {
  const entries = text.split("\n").flatMap((line): SessionEntry[] => {
    try {
      return line.trim() ? [JSON.parse(line) as SessionEntry] : [];
    } catch {
      return [];
    }
  });
  const header = entries.find((entry) => entry.type === "session");
  const byId = new Map(entries.flatMap((entry) => (entry.id === undefined ? [] : [[entry.id, entry] as const])));
  const leaf = entries.findLast((entry) => entry.id !== undefined);
  const branch: SessionEntry[] = [];
  for (let current = leaf; current; current = current.parentId ? byId.get(current.parentId) : undefined) {
    branch.push(current);
  }
  branch.reverse();
  const name = branch.findLast((entry) => entry.type === "session_info")?.name;
  return { cwd: header?.cwd, name, startedAt: header?.timestamp, branch };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? block.text : block?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function truncate(text: string, max: number, entryId: string | undefined): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated; read entry ${entryId} for the rest]`;
}

function toolStub(call: { name: string; arguments?: unknown }): string {
  const args = JSON.stringify(call.arguments ?? {});
  return `[tool ${call.name}: ${args.length > 120 ? `${args.slice(0, 120)}…` : args}]`;
}

/** Renders one entry as `{ label, text }`, or undefined when the entry has nothing to show. */
export function renderEntry(
  entry: SessionEntry,
  tools: ToolsMode,
  maxChars: number,
): { label: string; text: string } | undefined {
  const finish = (label: string, text: string) =>
    text.trim() ? { label, text: truncate(text.trim(), maxChars, entry.id) } : undefined;
  if (entry.type === "compaction" || entry.type === "branch_summary") return finish("summary", entry.summary ?? "");
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  if (message?.role === "user") return finish("user", textOf(message.content));
  if (message?.role === "assistant") {
    const calls = Array.isArray(message.content)
      ? message.content.filter((block: { type?: string }) => block?.type === "toolCall")
      : [];
    const callText =
      tools === "none"
        ? []
        : calls.map((call: { name: string; arguments?: unknown }) =>
            tools === "full" ? `[tool ${call.name}] ${JSON.stringify(call.arguments)}` : toolStub(call),
          );
    return finish("assistant", [textOf(message.content), ...callText].filter(Boolean).join("\n"));
  }
  if (message?.role === "toolResult") {
    if (tools === "none" || (tools === "stubs" && !message.isError)) return undefined;
    const prefix = `[${message.isError ? "tool error" : "tool result"} ${message.toolName}]`;
    return finish("tool", `${prefix}\n${textOf(message.content)}`);
  }
  return undefined;
}

function formatEntry(entry: SessionEntry, rendered: { label: string; text: string }): string {
  return `**${rendered.label}** · ${entry.timestamp?.slice(0, 16).replace("T", " ") ?? "?"} · \`${entry.id ?? "?"}\`\n\n${rendered.text}`;
}

function snippetAround(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ");
  const at = Math.max(0, flat.toLowerCase().indexOf(terms[0]!));
  const start = Math.max(0, at - 80);
  return `${start > 0 ? "…" : ""}${flat.slice(start, at + 160)}${flat.length > at + 160 ? "…" : ""}`;
}

/** Finds entries containing every term (case-insensitive), at most a few per session, newest session first. */
export async function searchSessions(
  files: SessionFile[],
  terms: string[],
  limit: number,
  signal?: AbortSignal,
): Promise<{ hits: SearchHit[]; skipped: number; stoppedAtLimit: boolean }> {
  const hits: SearchHit[] = [];
  let skipped = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    if (hits.length >= limit) return { hits, skipped, stoppedAtLimit: true };
    if (((await stat(file.path).catch(() => undefined))?.size ?? 0) > MAX_FILE_BYTES) {
      skipped += 1;
      continue;
    }
    const raw = await readFile(file.path, "utf8").catch(() => "");
    const lower = raw.toLowerCase();
    // Cheap whole-file check first so only plausible sessions get parsed.
    if (!terms.every((term) => lower.includes(term))) continue;
    const session = parseSession(raw);
    const matches = session.branch.flatMap((entry) => {
      const rendered = renderEntry(entry, "full", Infinity);
      const haystack = rendered?.text.toLowerCase();
      return rendered && haystack && terms.every((term) => haystack.includes(term)) ? [{ entry, rendered }] : [];
    });
    matches.slice(0, MAX_HITS_PER_SESSION).forEach(({ entry, rendered }) =>
      hits.push({
        sessionId: file.id,
        cwd: session.cwd,
        name: session.name,
        entryId: entry.id ?? "?",
        time: entry.timestamp?.slice(0, 16).replace("T", " ") ?? "?",
        snippet: `${rendered.label}: ${snippetAround(rendered.text, terms)}`,
      }),
    );
  }
  return { hits, skipped, stoppedAtLimit: false };
}

/** Renders a session as a markdown transcript page, or a single entry in full. */
export async function readSession(
  file: SessionFile,
  options: { from?: string | undefined; entry?: string | undefined; tools: ToolsMode; maxChars: number },
): Promise<string> {
  const session = parseSession(await readFile(file.path, "utf8"));
  const title = `# ${session.name ?? file.id}\n${session.cwd ?? "?"} · started ${session.startedAt ?? "?"} · session ${file.id}`;

  if (options.entry !== undefined) {
    const entry = session.branch.find((candidate) => candidate.id === options.entry);
    const rendered = entry && renderEntry(entry, "full", SINGLE_ENTRY_CHARS);
    return rendered
      ? `${title}\n\n${formatEntry(entry, rendered)}`
      : `${title}\n\nEntry ${options.entry} not found on the active branch.`;
  }

  const blocks = session.branch.flatMap((entry) => {
    const rendered = renderEntry(entry, options.tools, TRANSCRIPT_ENTRY_CHARS);
    return rendered ? [{ id: entry.id, text: formatEntry(entry, rendered) }] : [];
  });
  const startIndex = options.from === undefined ? 0 : blocks.findIndex((block) => block.id === options.from);
  if (startIndex < 0)
    return `${title}\n\nEntry ${options.from} not found (or has no visible content with tools="${options.tools}").`;

  const page: string[] = [];
  let used = 0;
  for (const block of blocks.slice(startIndex)) {
    if (page.length > 0 && used + block.text.length > options.maxChars) break;
    page.push(block.text);
    used += block.text.length;
  }
  const next = blocks[startIndex + page.length];
  const footer = next ? `\n\n---\nMore content: call again with from="${next.id}".` : "";
  return `${title}\n\n${page.join("\n\n")}${footer}`;
}
