import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
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
type WorkerResult = { items: string[]; totalMatched: number; totalFiles: number };
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
};
type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

function limit(value: number): number {
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function timeoutMs(value: number | undefined): number {
  return Math.max(1, Math.floor(value ?? DEFAULT_TIMEOUT_SECONDS)) * 1_000;
}

function query(path: string | undefined, pattern: string, cwd: string): string {
  if (!path) return pattern;
  if (path.startsWith("/") || path.startsWith("~") || path === ".." || path.startsWith("../")) {
    throw new Error("Search paths must stay within the workspace.");
  }
  const target = resolve(cwd, path);
  if (target !== cwd && !target.startsWith(`${cwd}/`)) throw new Error("Search paths must stay within the workspace.");
  return `${path} ${pattern}`;
}

function formatGrep(result: WorkerGrepResult): string {
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
  private child: ChildProcess | undefined;
  private buffer = "";
  private nextId = 0;
  private pending = new Map<number, Pending>();

  private start(): ChildProcess {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn("bun", [WORKER_PATH], { stdio: ["pipe", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.once("exit", () => this.stop(new Error("FFF worker stopped.")));
    child.once("error", (error) => this.stop(error));
    this.child = child;
    return child;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = JSON.parse(line) as { id: number; ok: boolean; result?: unknown; error?: string };
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "FFF search failed."));
    }
  }

  stop(error = new Error("FFF search cancelled.")): void {
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill("SIGKILL");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request<T>(request: Record<string, unknown>, signal: AbortSignal, timeout: number): Promise<T> {
    if (signal.aborted) throw new Error("FFF search cancelled.");
    const child = this.start();
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new Error("FFF search timed out.")), timeout);
      const abort = () => this.stop();
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      child.stdin?.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  }
}

export default function fff(pi: ExtensionAPI): void {
  const worker = new FffWorker();

  pi.registerTool({
    name: "fffind",
    label: "Find files",
    description: "Find files in the current workspace. For another repository, use `bash` with `rg --files <path>`.",
    parameters: FindParams,
    async execute(_id, params: FindInput, signal, _update, ctx) {
      const result = await worker.request<WorkerResult>(
        {
          cwd: ctx.cwd,
          kind: "find",
          query: query(params.path, params.pattern, ctx.cwd),
          limit: limit(params.limit),
        },
        signal ?? new AbortController().signal,
        timeoutMs(params.timeout),
      );
      return {
        content: [{ type: "text", text: result.items.join("\n") || "No files found" }],
        details: { resultCount: result.items.length, totalMatched: result.totalMatched, totalFiles: result.totalFiles },
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
      "Search file contents in the current workspace. For another repository, use `bash` with `rg <pattern> <path>`.",
    parameters: GrepParams,
    async execute(_id, params: GrepInput, signal, _update, ctx) {
      const result = await worker.request<WorkerGrepResult>(
        {
          cwd: ctx.cwd,
          kind: "grep",
          query: query(params.path, params.pattern, ctx.cwd),
          limit: limit(params.limit),
          context: Math.min(20, Math.max(0, Math.floor(params.context ?? 0))),
          mode: /[.*+?^${}()|[\]\\]/.test(params.pattern) ? "regex" : "plain",
          timeoutMs: timeoutMs(params.timeout),
        },
        signal ?? new AbortController().signal,
        timeoutMs(params.timeout),
      );
      return {
        content: [{ type: "text", text: formatGrep(result) }],
        details: { resultCount: result.items.length, totalMatched: result.totalMatched, totalFiles: result.totalFiles },
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
