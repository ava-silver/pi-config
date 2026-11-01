import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_LIMIT = 50;
const MAX_GREP_OUTPUT_CHARS = 12_000;

const FindParams = Type.Object({
  pattern: Type.String({ description: "Filename or path terms in the current workspace." }),
  path: Type.Optional(Type.String({ description: "Relative workspace directory or glob." })),
  limit: Type.Number({ description: "Maximum results." }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 30)." })),
});

const GrepParams = Type.Object({
  pattern: Type.String({ description: "Literal text to search for in the current workspace." }),
  path: Type.Optional(Type.String({ description: "Relative workspace directory or glob." })),
  context: Type.Optional(Type.Number({ description: "Context lines (0-20)." })),
  limit: Type.Number({ description: "Maximum matches." }),
  regex: Type.Optional(Type.Boolean({ description: "Treat pattern as a regular expression (default false)." })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 30)." })),
});

type FindInput = Static<typeof FindParams>;
type GrepInput = Static<typeof GrepParams>;
type WorkerResult = { items: string[]; resultCount: number; totalMatched: number; totalFiles: number };
type WorkerGrepResult = {
  items: Array<{
    relativePath: string;
    lineNumber: number;
    lineContent: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }>;
  totalMatched: number;
  totalFiles: number;
  resultCount: number;
  output?: string;
};
function limit(value: number): number {
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function timeoutMs(value: number | undefined): number {
  return Math.max(1, Math.floor(value ?? DEFAULT_TIMEOUT_SECONDS)) * 1_000;
}

function isWorkspacePath(path: string | undefined, cwd: string): boolean {
  if (!path || path.startsWith("~")) return !path?.startsWith("~");
  const target = resolve(cwd, path);
  return target === cwd || target.startsWith(`${cwd}/`);
}

function isWorkspaceFile(path: string | undefined, cwd: string): boolean {
  if (!path || /[*?[{]/.test(path)) return false;
  try {
    return statSync(resolve(cwd, path)).isFile();
  } catch {
    const name = path.split("/").at(-1) ?? "";
    return /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(name);
  }
}

function query(path: string | undefined, pattern: string, cwd: string): string {
  if (!path) return pattern;
  const normalized = (path.startsWith("/") ? relative(cwd, path) : path).replace(/^\.\//, "");
  if (normalized === ".") return pattern;
  const lastSegment = normalized.split("/").at(-1) ?? "";
  const constraint =
    normalized.endsWith("/") || /[*?[{]/.test(normalized) || /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)
      ? normalized
      : `${normalized}/`;
  return `${constraint} ${pattern}`;
}

function killWorker(child: ChildProcess): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The worker may have already stopped.
    }
  }
  child.kill("SIGKILL");
}

function truncateGrepOutput(output: string): string {
  if (output.length <= MAX_GREP_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_GREP_OUTPUT_CHARS)}\n\n[Output truncated at ${MAX_GREP_OUTPUT_CHARS.toLocaleString()} characters. Narrow the search path or reduce context.]`;
}

function formatGrep(result: WorkerGrepResult): string {
  if (result.output !== undefined) return truncateGrepOutput(result.output) || "No matches found";
  if (result.items.length === 0) return "No matches found";
  let previousPath = "";
  const lines: string[] = [];
  for (const item of result.items) {
    if (item.relativePath !== previousPath) {
      if (lines.length) lines.push("");
      previousPath = item.relativePath;
      lines.push(item.relativePath);
    }
    item.contextBefore?.forEach((line, index) =>
      lines.push(` ${item.lineNumber - item.contextBefore!.length + index}- ${line}`),
    );
    lines.push(` ${item.lineNumber}: ${item.lineContent}`);
    item.contextAfter?.forEach((line, index) => lines.push(` ${item.lineNumber + index + 1}- ${line}`));
  }
  return truncateGrepOutput(lines.join("\n"));
}

type WorkerResponse = { id: number; ok: boolean; result?: unknown; error?: unknown };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

// A long-lived worker process keeps a warm index per workspace. Native searches block, so they run off the UI
// thread, and a search that outlives its timeout is killed and replaced.
class FffWorker {
  private child: ChildProcess | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextId = 0;

  stop(error = new Error("FFF worker stopped.")): void {
    const child = this.child;
    this.child = undefined;
    if (child) killWorker(child);
    this.pending.forEach((request) => request.reject(error));
    this.pending.clear();
  }

  private start(): ChildProcess {
    if (this.child) return this.child;
    const child = spawn("bun", [WORKER_PATH], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach((line) => this.handleLine(line));
    });
    const stopIfCurrent = (error: Error) => {
      if (this.child === child) this.stop(error);
    };
    child.once("error", stopIfCurrent);
    child.once("exit", () => stopIfCurrent(new Error("FFF worker stopped.")));
    child.stdin.on("error", stopIfCurrent);
    child.unref();
    this.child = child;
    return child;
  }

  private handleLine(line: string): void {
    try {
      const { id, ok, result, error } = JSON.parse(line) as WorkerResponse;
      const request = this.pending.get(id);
      this.pending.delete(id);
      if (ok) request?.resolve(result);
      else request?.reject(new Error(typeof error === "string" ? error : "FFF search failed."));
    } catch {
      this.stop(new Error("FFF worker returned invalid output."));
    }
  }

  request<T>(request: Record<string, unknown>, signal: AbortSignal, timeout: number): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error("FFF search cancelled."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("FFF search timed out."));
        this.stop(new Error("FFF worker restarted after a timeout."));
      }, timeout);
      const abort = () => {
        cleanup();
        reject(new Error("FFF search cancelled."));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      this.start().stdin?.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  }
}

export default function fff(pi: ExtensionAPI): void {
  const worker = new FffWorker();

  pi.registerTool({
    name: "fffind",
    label: "Find files",
    description:
      "Preferred workspace file search. Use instead of `find`, `fd`, or `rg --files`. For another repository, use `bash` with `rg --files <path>`.",
    parameters: FindParams,
    async execute(_id, params: FindInput, signal, _update, ctx) {
      const workspacePath = isWorkspacePath(params.path, ctx.cwd);
      const useFff = workspacePath && !isWorkspaceFile(params.path, ctx.cwd);
      const result = await worker.request<WorkerResult>(
        {
          cwd: ctx.cwd,
          kind: useFff ? "find" : "external-find",
          query: useFff ? query(params.path, params.pattern, ctx.cwd) : (params.path ?? ctx.cwd),
          limit: limit(params.limit),
        },
        signal ?? new AbortController().signal,
        timeoutMs(params.timeout),
      );
      return {
        content: [{ type: "text", text: result.items.join("\n") || "No files found" }],
        details: { resultCount: result.resultCount, totalMatched: result.totalMatched, totalFiles: result.totalFiles },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const scope = args.path ?? ".";
      const timeout = args.timeout ?? DEFAULT_TIMEOUT_SECONDS;
      text.setText(
        `${theme.fg("toolTitle", theme.bold("fffind"))} ${theme.fg("accent", args.pattern)}${theme.fg("toolOutput", ` in ${scope} · ${args.limit} results · ${timeout}s`)}`,
      );
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const output = result.content.find((item) => item.type === "text")?.text ?? "";
      const resultCount = (result.details as { resultCount?: number }).resultCount ?? 0;
      text.setText(`${theme.fg("muted", `${resultCount} results`)}\n${theme.fg("toolOutput", output)}`);
      return text;
    },
  });

  pi.registerTool({
    name: "ffgrep",
    label: "Search files",
    description:
      "Preferred workspace content search. Searches literal text by default; set `regex` to true for regular expressions. Use instead of `grep` or `rg`: it uses an indexed, isolated worker and per-call timeouts. Scope `path` narrowly when possible. For another repository, use `bash` with `rg <pattern> <path>`.",
    parameters: GrepParams,
    async execute(_id, params: GrepInput, signal, _update, ctx) {
      const workspacePath = isWorkspacePath(params.path, ctx.cwd);
      const useFff = workspacePath && !isWorkspaceFile(params.path, ctx.cwd);
      const result = await worker.request<WorkerGrepResult>(
        {
          cwd: ctx.cwd,
          kind: useFff ? "grep" : "external-grep",
          query: useFff ? query(params.path, params.pattern, ctx.cwd) : (params.path ?? ctx.cwd),
          pattern: params.pattern,
          limit: limit(params.limit),
          context: Math.min(20, Math.max(0, Math.floor(params.context ?? 0))),
          mode: params.regex ? "regex" : "plain",
          // Let the search stop itself before the request timeout replaces the worker.
          timeoutMs: Math.floor(timeoutMs(params.timeout) * 0.8),
        },
        signal ?? new AbortController().signal,
        timeoutMs(params.timeout),
      );
      return {
        content: [{ type: "text", text: formatGrep(result) }],
        details: { resultCount: result.resultCount, totalMatched: result.totalMatched, totalFiles: result.totalFiles },
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const scope = args.path ?? ".";
      const timeout = args.timeout ?? DEFAULT_TIMEOUT_SECONDS;
      text.setText(
        `${theme.fg("toolTitle", theme.bold("ffgrep"))} ${theme.fg("accent", args.regex ? `/${args.pattern}/` : args.pattern)}${theme.fg("toolOutput", ` in ${scope} · limit ${args.limit} · timeout ${timeout}s`)}`,
      );
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const output = result.content.find((item) => item.type === "text")?.text ?? "";
      const resultCount = (result.details as { resultCount?: number }).resultCount ?? 0;
      text.setText(`${theme.fg("muted", `${resultCount} results`)}\n${theme.fg("toolOutput", output)}`);
      return text;
    },
  });

  pi.on("session_shutdown", () => worker.stop(new Error("FFF session ended.")));
}
