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

const FindParams = Type.Object({
  pattern: Type.String({ description: "Filename or path terms in the current workspace." }),
  path: Type.Optional(Type.String({ description: "Relative workspace directory or glob." })),
  limit: Type.Number({ description: "Maximum results." }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 30)." })),
});

const GrepParams = Type.Object({
  pattern: Type.String({ description: "Text or regular expression in the current workspace." }),
  path: Type.Optional(Type.String({ description: "Relative workspace directory or glob." })),
  context: Type.Optional(Type.Number({ description: "Context lines (0-20)." })),
  limit: Type.Number({ description: "Maximum matches." }),
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

function grepMode(pattern: string): "plain" | "regex" {
  return /[.*+?^${}()|[\]\\]/.test(pattern) ? "regex" : "plain";
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

function formatGrep(result: WorkerGrepResult): string {
  if (result.output !== undefined) return result.output || "No matches found";
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
  return lines.join("\n");
}

class FffWorker {
  private children = new Set<ChildProcess>();
  private nextId = 0;

  stop(_error?: Error): void {
    for (const child of this.children) killWorker(child);
    this.children.clear();
  }

  async request<T>(request: Record<string, unknown>, signal: AbortSignal, timeout: number): Promise<T> {
    if (signal.aborted) throw new Error("FFF search cancelled.");
    const id = ++this.nextId;
    const child = spawn("bun", [WORKER_PATH], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.children.add(child);
    child.stdout.setEncoding("utf8");

    return new Promise<T>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.children.delete(child);
        if (!child.killed) killWorker(child);
        if (error) reject(error);
        else resolve(result as T);
      };
      const timer = setTimeout(() => finish(new Error("FFF search timed out.")), timeout);
      const abort = () => finish(new Error("FFF search cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const message = JSON.parse(line) as { id: unknown; ok: unknown; result?: unknown; error?: unknown };
            if (typeof message.id !== "number" || typeof message.ok !== "boolean")
              throw new Error("Invalid FFF worker output.");
            if (message.id !== id) continue;
            finish(
              message.ok
                ? undefined
                : new Error(typeof message.error === "string" ? message.error : "FFF search failed."),
              message.result,
            );
          } catch {
            finish(new Error("FFF worker returned invalid output."));
          }
        }
      });
      child.once("error", (error) => finish(error));
      child.once("exit", () => finish(new Error("FFF worker stopped.")));
      if (!child.stdin) {
        finish(new Error("FFF worker stdin is unavailable."));
        return;
      }
      child.stdin.once("error", (error) => finish(error));
      child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (error) => {
        if (error) finish(error);
      });
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
      "Preferred workspace content search. Use instead of `grep` or `rg`: it uses an indexed, isolated worker and per-call timeouts. Scope `path` narrowly when possible. For another repository, use `bash` with `rg <pattern> <path>`.",
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
          mode: grepMode(params.pattern),
          timeoutMs: timeoutMs(params.timeout),
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
        `${theme.fg("toolTitle", theme.bold("ffgrep"))} ${theme.fg("accent", `/${args.pattern}/`)}${theme.fg("toolOutput", ` in ${scope} · limit ${args.limit} · timeout ${timeout}s`)}`,
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
