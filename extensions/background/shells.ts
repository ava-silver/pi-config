/**
 * Background shells -- run long-lived shell commands, inspect output, or
 * cancel them.
 *
 * Tools (for the parent LLM):
 * - background_shell_run: start a long-running command in the background and return an id immediately (command, title, working_dir).
 * - background_shell_cancel: kill one or more background shells.
 * - background_shell_check: peek at status and recent output.
 * - background_shell_list: list all background shells.
 *
 * Shell output is delivered automatically when the command settles. The parent
 * can inspect or cancel it. `/background` opens the shared task picker.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerTransientSegment } from "../shared/footer-segments.ts";
import { killProcessTree } from "../shared/process-tree.ts";
import type { BackgroundHub } from "./src/hub.ts";

// --- Config ----------------------------------------------------------------

const OUTPUT_CAP_BYTES = 512 * 1024; // rolling buffer cap per terminal
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const CHECK_PREVIEW_BYTES = 4 * 1024;
const FOLLOW_UP_BYTES = 24 * 1024;
export const MAX_RUNNING_TERMINALS = 16;
export const MAX_TRACKED_TERMINALS = 128;

// --- Domain ----------------------------------------------------------------

export type TerminalStatus = "running" | "done" | "error";

interface Terminal {
  id: string;
  title: string;
  command: string;
  cwd: string;
  status: TerminalStatus;
  exitCode: number | undefined;
  /** Combined stdout+stderr, trimmed to OUTPUT_CAP_BYTES. */
  output: Buffer[];
  outputBytes: number;
  pid: number | undefined;
  startedAt: number;
  endedAt: number | undefined;
  proc: child_process.ChildProcess | undefined;
  artifactDir: string | undefined;
  artifactPath: string | undefined;
  artifactStream: fs.WriteStream | undefined;
  artifactFinalizing: Promise<void> | undefined;
  artifactBlocked: boolean;
  settling: Promise<void> | undefined;
  settled: Promise<void>;
  resolveSettled: () => void;
  killRequested: boolean;
  killNotify: boolean;
  artifactBytes: number;
  artifactStatus: "available" | "truncated" | "unavailable";
  abortCleanup: (() => void) | undefined;
}

let counter = 0;
function nextId() {
  return `tr-${++counter}`;
}

function elapsed(t: Terminal): string {
  const ms = (t.endedAt ?? Date.now()) - t.startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function describe(t: Terminal): string {
  const artifact = artifactNotice(t);
  return `${t.id} [${t.status}] "${t.title}" (${elapsed(t)}, ${t.cwd})${artifact ? ` ${artifact}` : ""}`;
}

function pauseOutput(t: Terminal): void {
  t.proc?.stdout?.pause();
  t.proc?.stderr?.pause();
}

function resumeOutput(t: Terminal): void {
  t.proc?.stdout?.resume();
  t.proc?.stderr?.resume();
}

function finishArtifact(t: Terminal): Promise<void> {
  if (t.artifactFinalizing) return t.artifactFinalizing;
  const stream = t.artifactStream;
  if (!stream) return Promise.resolve();
  t.artifactStream = undefined;
  if (t.artifactBlocked) {
    t.artifactBlocked = false;
    resumeOutput(t);
  }
  t.artifactFinalizing = new Promise((resolve) => {
    stream.once("close", resolve);
    stream.end();
  });
  return t.artifactFinalizing;
}

function failArtifact(t: Terminal): void {
  t.artifactStatus = "unavailable";
  void finishArtifact(t);
}

/** Append a chunk to a terminal's bounded combined output buffer and artifact. */
function appendOutput(t: Terminal, chunk: Buffer | string): void {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const stream = t.artifactStream;
  if (stream) {
    const length = Math.min(bytes.length, Math.max(0, MAX_ARTIFACT_BYTES - t.artifactBytes));
    if (length > 0) {
      try {
        t.artifactBytes += length;
        if (!stream.write(bytes.subarray(0, length))) {
          t.artifactBlocked = true;
          pauseOutput(t);
          stream.once("drain", () => {
            t.artifactBlocked = false;
            if (t.artifactStream === stream) resumeOutput(t);
          });
        }
      } catch {
        failArtifact(t);
      }
    }
    if (bytes.length > length) {
      t.artifactStatus = "truncated";
      void finishArtifact(t);
    }
  }
  t.output.push(bytes);
  t.outputBytes += bytes.length;
  while (t.outputBytes > OUTPUT_CAP_BYTES) {
    const first = t.output[0];
    if (!first) break;
    const excess = t.outputBytes - OUTPUT_CAP_BYTES;
    if (first.length <= excess) {
      t.output.shift();
      t.outputBytes -= first.length;
    } else {
      t.output[0] = first.subarray(excess);
      t.outputBytes -= excess;
    }
  }
}

function outputText(t: Terminal): string {
  return Buffer.concat(t.output).toString();
}

interface TerminalTextResult {
  text: string;
  truncated: boolean;
}

export function truncateTerminalText(content: string, notice?: string): TerminalTextResult {
  const suffix = notice ? `\n${notice}` : "";
  const truncation = truncateTail(content, {
    maxBytes: Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8")),
    maxLines: notice ? DEFAULT_MAX_LINES - 1 : DEFAULT_MAX_LINES,
  });
  return {
    text: truncation.content + (truncation.truncated ? suffix : ""),
    truncated: truncation.truncated,
  };
}

function artifactNotice(t: Terminal): string | undefined {
  if (t.artifactStatus === "truncated")
    return `[Artifact truncated at ${formatSize(MAX_ARTIFACT_BYTES)}; not full output.]`;
  if (t.artifactStatus === "unavailable") return "[Artifact unavailable; not full output.]";
  return undefined;
}

function terminalOutput(t: Terminal, maxBytes = DEFAULT_MAX_BYTES): TerminalTextResult {
  const artifact = artifactNotice(t);
  const outputNotice =
    t.artifactStatus === "available"
      ? `[Output truncated at ${formatSize(maxBytes)}. Full output: ${t.artifactPath}]`
      : `[Output truncated at ${formatSize(maxBytes)}. ${artifact}]`;
  const reservedBytes =
    Buffer.byteLength(outputNotice, "utf8") + (artifact ? Buffer.byteLength(artifact, "utf8") + 1 : 0) + 1;
  const truncation = truncateTail(outputText(t) || "(no output)", {
    maxBytes: Math.max(0, Math.min(maxBytes, DEFAULT_MAX_BYTES) - reservedBytes),
    maxLines: DEFAULT_MAX_LINES - (artifact ? 2 : 1),
  });
  const notices = [truncation.truncated ? outputNotice : undefined, artifact].filter(
    (notice): notice is string => notice !== undefined,
  );
  return {
    text: truncation.content + (notices.length ? `\n${notices.join("\n")}` : ""),
    truncated: truncation.truncated,
  };
}

export function settledTerminalIdsToPrune(
  terminals: ReadonlyArray<{
    id: string;
    status: TerminalStatus;
    startedAt: number;
    endedAt: number | undefined;
  }>,
  maxTracked: number = MAX_TRACKED_TERMINALS,
): string[] {
  return terminals
    .filter((t) => t.status !== "running")
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, terminals.length - maxTracked))
    .map((t) => t.id);
}

/** Best-effort cleanup so retention never turns a failed removal into an extension failure. */
export async function removeTerminalArtifactDirectory(artifactDir: string | undefined): Promise<void> {
  if (!artifactDir) return;
  try {
    await fs.promises.rm(artifactDir, { recursive: true, force: true });
  } catch {}
}

// --- Extension -------------------------------------------------------------

interface ShellManager {
  terminals: Map<string, Terminal>;
  listeners: Set<() => void>;
  start(ctx: ExtensionContext): void;
  shutdown(): Promise<void>;
  flushPending(): void;
  refresh(): void;
  spawn(opts: { command: string; title: string; cwd: string }, signal?: AbortSignal): Promise<Terminal>;
  kill(terminal: Terminal, notify: boolean): boolean;
}

function createTerminal(
  opts: { command: string; title: string; cwd: string },
  artifact: {
    dir: string | undefined;
    path: string | undefined;
    stream: fs.WriteStream | undefined;
    status: Terminal["artifactStatus"];
  },
): Terminal {
  let resolveSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return {
    id: nextId(),
    title: opts.title,
    command: opts.command,
    cwd: opts.cwd,
    status: "running",
    exitCode: undefined,
    output: [],
    outputBytes: 0,
    pid: undefined,
    startedAt: Date.now(),
    endedAt: undefined,
    proc: undefined,
    artifactDir: artifact.dir,
    artifactPath: artifact.path,
    artifactStream: artifact.stream,
    artifactFinalizing: undefined,
    artifactBlocked: false,
    settling: undefined,
    settled,
    resolveSettled,
    killRequested: false,
    killNotify: false,
    artifactBytes: 0,
    artifactStatus: artifact.status,
    abortCleanup: undefined,
  };
}

function createShellManager(pi: ExtensionAPI): ShellManager {
  const terminals = new Map<string, Terminal>();
  const pending = new Map<string, Terminal>();
  const listeners = new Set<() => void>();
  let sessionCtx: ExtensionContext | undefined;
  const updateStatus = () => {
    const visible = [...terminals.values()].filter((terminal) => !terminal.killRequested);
    if (visible.length === 0) {
      registerTransientSegment("terminals", null);
      return;
    }
    const running = visible.filter((terminal) => terminal.status === "running").length;
    const failed = visible.filter((terminal) => terminal.status === "error").length;
    const parts = [
      running > 0 ? `${running} running` : undefined,
      visible.length - running - failed > 0 ? `${visible.length - running - failed} done` : undefined,
      failed > 0 ? `${failed} failed` : undefined,
    ].filter((part): part is string => part !== undefined);
    registerTransientSegment("terminals", {
      text: `$ ${parts.join(" · ")}`,
      bg: failed > 0 ? "#e78284" : running > 0 ? "#81c8be" : "#a6d189",
      fg: "#1e2030",
    });
  };
  const notifyListeners = () => {
    for (const listener of listeners) listener();
  };
  const deliverResult = (terminal: Terminal) => {
    const verb = terminal.status === "error" ? "failed" : "finished";
    const exitInfo = terminal.exitCode !== undefined ? ` (exit ${terminal.exitCode})` : "";
    const { text: body } = terminalOutput(terminal, FOLLOW_UP_BYTES);
    pi.sendMessage(
      {
        customType: "terminal-result",
        content: truncateTerminalText(
          `Background shell ${terminal.id} "${terminal.title}" ${verb}${exitInfo}\n\n${body}`,
        ).text,
        display: true,
        details: {
          id: terminal.id,
          title: terminal.title,
          status: terminal.status,
          exitCode: terminal.exitCode,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };
  const flushPending = () => {
    for (const terminal of pending.values()) deliverResult(terminal);
    pending.clear();
  };
  const onSettled = (terminal: Terminal) => {
    updateStatus();
    notifyListeners();
    if (!sessionCtx) return;
    pending.set(terminal.id, { ...terminal });
    if (sessionCtx.isIdle()) flushPending();
  };
  const closeArtifact = async (terminal: Terminal) => {
    await finishArtifact(terminal);
    terminal.abortCleanup?.();
    terminal.abortCleanup = undefined;
  };
  const settleTerminal = (
    terminal: Terminal,
    status: TerminalStatus,
    exitCode: number | undefined,
    deliver: boolean,
    notify: boolean,
  ): Promise<void> => {
    if (terminal.settling) return terminal.settling;
    terminal.settling = (async () => {
      await closeArtifact(terminal);
      if (terminal.endedAt !== undefined) return;
      terminal.exitCode = exitCode;
      terminal.status = status;
      terminal.endedAt = Date.now();
      terminal.proc = undefined;
      if (deliver) onSettled(terminal);
      else if (notify) {
        notifyListeners();
        updateStatus();
      }
    })().finally(terminal.resolveSettled);
    return terminal.settling;
  };
  const removeArtifact = async (terminal: Terminal) => {
    if (terminal.killRequested) await terminal.settled;
    else if (terminal.settling) await terminal.settling;
    else await closeArtifact(terminal);
    await removeTerminalArtifactDirectory(terminal.artifactDir);
  };
  const pruneTerminals = () => {
    for (const id of settledTerminalIdsToPrune([...terminals.values()], MAX_TRACKED_TERMINALS - 1)) {
      const terminal = terminals.get(id);
      if (!terminal) continue;
      terminals.delete(id);
      pending.delete(id);
      void removeArtifact(terminal);
    }
  };
  const kill = (terminal: Terminal, notify: boolean) => {
    if (terminal.status !== "running" || terminal.settling || terminal.killRequested) return false;
    terminal.killRequested = true;
    terminal.killNotify = notify;
    pending.delete(terminal.id);
    appendOutput(terminal, "\n[process killed]\n");
    if (terminal.pid !== undefined) killProcessTree(terminal.pid);
    return true;
  };
  const spawn = async (
    opts: { command: string; title: string; cwd: string },
    signal?: AbortSignal,
  ): Promise<Terminal> => {
    pruneTerminals();
    if ([...terminals.values()].filter((terminal) => terminal.status === "running").length >= MAX_RUNNING_TERMINALS)
      throw new Error(`Max ${MAX_RUNNING_TERMINALS} running terminals reached.`);
    if (terminals.size >= MAX_TRACKED_TERMINALS)
      throw new Error(`Max ${MAX_TRACKED_TERMINALS} tracked terminals reached.`);
    let artifactDir: string | undefined;
    let artifactPath: string | undefined;
    let artifactStream: fs.WriteStream | undefined;
    let artifactStatus: Terminal["artifactStatus"] = "available";
    try {
      artifactDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-terminal-"));
      await fs.promises.chmod(artifactDir, 0o700);
      artifactPath = path.join(artifactDir, "output.log");
      artifactStream = fs.createWriteStream(artifactPath, {
        flags: "w",
        mode: 0o600,
      });
      await new Promise<void>((resolve, reject) => {
        artifactStream?.once("open", resolve);
        artifactStream?.once("error", reject);
      });
    } catch {
      artifactStatus = "unavailable";
      artifactStream?.destroy();
      await removeTerminalArtifactDirectory(artifactDir);
      artifactDir = undefined;
      artifactPath = undefined;
      artifactStream = undefined;
    }
    const terminal = createTerminal(opts, {
      dir: artifactDir,
      path: artifactPath,
      stream: artifactStream,
      status: artifactStatus,
    });
    if (artifactStream) artifactStream.on("error", () => failArtifact(terminal));
    terminals.set(terminal.id, terminal);
    updateStatus();
    const proc = child_process.spawn("bash", ["-c", opts.command], {
      cwd: opts.cwd,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    terminal.proc = proc;
    terminal.pid = proc.pid;
    proc.stdout.on("data", (chunk: Buffer) => appendOutput(terminal, chunk));
    proc.stderr.on("data", (chunk: Buffer) => appendOutput(terminal, chunk));
    const settle = (code: number | null, error?: Error) => {
      if (error) appendOutput(terminal, `\n[spawn error: ${error.message}]`);
      const killed = terminal.killRequested;
      void settleTerminal(
        terminal,
        killed || error || code !== 0 ? "error" : "done",
        killed ? undefined : (code ?? undefined),
        !killed,
        killed && terminal.killNotify,
      );
    };
    proc.on("close", (code: number | null) => settle(code));
    proc.on("error", (error: Error) => settle(null, error));
    const abort = () => kill(terminal, true);
    if (signal?.aborted) abort();
    else if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      terminal.abortCleanup = () => signal.removeEventListener("abort", abort);
    }
    return terminal;
  };
  return {
    terminals,
    listeners,
    refresh: () => {
      updateStatus();
      notifyListeners();
    },
    flushPending,
    spawn,
    kill,
    start: (ctx) => {
      sessionCtx = ctx;
    },
    async shutdown() {
      sessionCtx = undefined;
      pending.clear();
      listeners.clear();
      const tracked = [...terminals.values()];
      for (const terminal of tracked) kill(terminal, false);
      terminals.clear();
      await Promise.all(tracked.map(removeArtifact));
      registerTransientSegment("terminals", null);
    },
  };
}

function registerShellLifecycle(pi: ExtensionAPI, background: BackgroundHub, shells: ShellManager) {
  let unregisterProvider: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    shells.start(ctx);
    unregisterProvider?.();
    unregisterProvider = background.registerProvider("terminals", {
      label: "Background Shells",
      list: () =>
        [...shells.terminals.values()]
          .filter((terminal) => terminal.status === "running")
          .map((terminal) => ({
            id: terminal.id,
            title: terminal.title,
            status: terminal.status,
            elapsed: () => elapsed(terminal),
            meta: () => [terminal.command.length > 48 ? terminal.command.slice(0, 45) + "…" : terminal.command],
          })),
      subscribe(cb) {
        shells.listeners.add(cb);
        return () => shells.listeners.delete(cb);
      },
      async openDetail(id, viewContext) {
        if (!shells.terminals.has(id)) return;
        await viewContext.ui.custom<null>(
          (tui, theme, keybindings, done) =>
            new TerminalOutputView({
              tui,
              theme,
              keybindings,
              id,
              getTerminal: () => shells.terminals.get(id),
              killTerminal: () => {
                const terminal = shells.terminals.get(id);
                if (terminal) shells.kill(terminal, true);
              },
              listeners: shells.listeners,
              done,
            }),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "100%",
              maxHeight: "100%",
            },
          },
        );
      },
      kill(id) {
        const terminal = shells.terminals.get(id);
        if (terminal) shells.kill(terminal, true);
      },
    });
  });
  pi.on("agent_settled", () => shells.flushPending());
  pi.on("session_shutdown", async () => {
    unregisterProvider?.();
    unregisterProvider = undefined;
    await shells.shutdown();
  });
}

function registerShellTools(pi: ExtensionAPI, shells: ShellManager) {
  pi.registerTool({
    name: "background_shell_run",
    label: "Run Background Shell",
    description:
      "Run a shell command expected to keep running, such as a dev server. Use the bash tool for commands that finish on their own. Returns immediately with a background shell ID. Use background_shell_check to peek at live output.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      title: Type.String({
        description: "Short human-readable label for this terminal, shown in listings",
      }),
      working_dir: Type.Optional(
        Type.String({
          description: "Working directory (default: current directory)",
        }),
      ),
    }),
    renderCall(args, theme) {
      return new Text(
        [
          theme.fg("toolTitle", "background_shell_run") + (args.title ? " " + theme.fg("dim", args.title) : ""),
          ...(args.command ? [theme.fg("text", `$ ${args.command}`)] : []),
          ...(args.working_dir ? [theme.fg("muted", `cwd: ${args.working_dir}`)] : []),
        ].join("\n"),
        0,
        0,
      );
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      try {
        if (!(await fs.promises.stat(cwd)).isDirectory()) throw new Error();
      } catch {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }
      const title = params.title.trim().slice(0, 160) || "terminal";
      if (signal?.aborted) throw new Error("Terminal run aborted.");
      const terminal = await shells.spawn({ command: params.command, title, cwd }, signal);
      return {
        content: [
          {
            type: "text",
            text: truncateTerminalText(
              `Started background shell ${terminal.id} "${terminal.title}" (pid ${terminal.pid ?? "?"}) in ${cwd}${artifactNotice(terminal) ? `\n${artifactNotice(terminal)}` : ""}`,
            ).text,
          },
        ],
        details: {
          id: terminal.id,
          title: terminal.title,
          pid: terminal.pid,
          cwd,
          artifactStatus: terminal.artifactStatus,
        },
      };
    },
  });
  pi.registerTool({
    name: "background_shell_cancel",
    label: "Cancel Background Shells",
    description: "Kill one or more running background shells.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: 'Terminal IDs to cancel, e.g. ["tr-1", "tr-2"]',
        maxItems: 64,
      }),
    }),
    async execute(_id, params) {
      const ids = [...new Set(params.ids)];
      if (ids.length === 0) throw new Error("Provide at least one terminal id.");
      const unknown = ids.filter((id) => !shells.terminals.has(id));
      if (unknown.length > 0)
        throw new Error(
          `Unknown background shell id(s): ${unknown.join(", ")}. Known: ${[...shells.terminals.keys()].join(", ") || "none"}.`,
        );
      const lines: string[] = [];
      const killed: Terminal[] = [];
      for (const id of ids) {
        const terminal = shells.terminals.get(id);
        if (!terminal) continue;
        if (shells.kill(terminal, false)) {
          killed.push(terminal);
          lines.push(
            `Killed ${id} "${terminal.title}".${artifactNotice(terminal) ? ` ${artifactNotice(terminal)}` : ""}`,
          );
        } else lines.push(`${id} "${terminal.title}" was already ${terminal.status}.`);
      }
      await Promise.all(killed.map((terminal) => terminal.settled));
      shells.refresh();
      return {
        content: [{ type: "text", text: truncateTerminalText(lines.join("\n")).text }],
        details: { ids },
      };
    },
  });
  pi.registerTool({
    name: "background_shell_check",
    label: "Check Background Shell",
    description: "Peek at a background shell's current status and recent output without blocking.",
    parameters: Type.Object({
      id: Type.String({ description: "Terminal ID to check" }),
    }),
    async execute(_callId, params) {
      const terminal = shells.terminals.get(params.id);
      if (!terminal)
        throw new Error(
          `Unknown background shell id "${params.id}". Known: ${[...shells.terminals.keys()].join(", ") || "none"}.`,
        );
      let text = `${describe(terminal)}\nCommand: ${terminal.command}`;
      if (terminal.exitCode !== undefined) text += `\nExit code: ${terminal.exitCode}`;
      const { text: preview } = terminalOutput(terminal, CHECK_PREVIEW_BYTES);
      text += preview ? `\n\nRecent output:\n${preview}` : "\n\n(no output yet)";
      return {
        content: [
          {
            type: "text",
            text: truncateTerminalText(text, "[Response truncated. See artifact status above.]").text,
          },
        ],
        details: {
          id: terminal.id,
          status: terminal.status,
          exitCode: terminal.exitCode,
          artifactStatus: terminal.artifactStatus,
        },
      };
    },
  });
  pi.registerTool({
    name: "background_shell_list",
    label: "List Background Shells",
    description: "List all background shells and their current status.",
    parameters: Type.Object({}),
    async execute() {
      const all = [...shells.terminals.values()];
      return {
        content: [
          {
            type: "text",
            text: truncateTerminalText(all.length === 0 ? "No background shells." : all.map(describe).join("\n")).text,
          },
        ],
        details: {
          terminals: all.map((terminal) => ({
            id: terminal.id,
            title: terminal.title,
            status: terminal.status,
            artifactStatus: terminal.artifactStatus,
          })),
        },
      };
    },
  });
}

export function setupShells(pi: ExtensionAPI, background: BackgroundHub) {
  const shells = createShellManager(pi);
  registerShellLifecycle(pi, background, shells);
  registerShellTools(pi, shells);
}

// --- TerminalOutputView -----------------------------------------------------

const SCROLL_STEP = 6;

// Strip ANSI codes and problematic control characters for clean TUI rendering.
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;
function sanitize(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

interface TerminalOutputViewOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  id: string;
  getTerminal: () => Terminal | undefined;
  killTerminal: () => void;
  listeners: Set<() => void>;
  done: (value: null) => void;
}

class TerminalOutputView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private getTerminal: () => Terminal | undefined;
  private killTerminal: () => void;
  private done: (value: null) => void;

  private scrollOffset = 0;
  private unsubscribe: () => void;
  private ticker: ReturnType<typeof setInterval>;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
  }

  constructor(options: TerminalOutputViewOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.id = options.id;
    this.getTerminal = options.getTerminal;
    this.killTerminal = options.killTerminal;
    this.done = options.done;
    const scheduleRender = () => this.scheduleRender();
    options.listeners.add(scheduleRender);
    this.unsubscribe = () => options.listeners.delete(scheduleRender);
    // Poll at 200 ms so live output stays fresh.
    this.ticker = setInterval(() => this.tui.requestRender(), 200);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  dispose(): void {
    this.cleanup();
  }

  private viewportHeight(): number {
    // 8 chrome rows: top border, header, command, content border, content border, hints, bottom border, +1 overlap
    return Math.max(6, (this.tui.terminal.rows || 30) - 8);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.interrupt") || this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight());
      this.tui.requestRender();
      return;
    }
    if (data === "x" && this.getTerminal()?.status === "running") this.killTerminal();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
    const t = this.getTerminal();
    const lines: string[] = [];
    lines.push(border);

    if (!t) {
      lines.push(theme.fg("dim", `${this.id} is no longer tracked`));
      lines.push(border);
      return lines;
    }

    const glyph =
      t.status === "running"
        ? theme.fg("warning", "■")
        : t.status === "done"
          ? theme.fg("success", "■")
          : theme.fg("error", "■");
    const exitInfo = t.exitCode !== undefined ? ` · exit ${t.exitCode}` : "";
    lines.push(
      truncateToWidth(
        `${glyph} ${theme.fg("accent", theme.bold(`${t.id} · ${t.title}`))}${theme.fg("muted", ` · ${t.status} · ${elapsed(t)}${exitInfo}`)}`,
        width,
      ),
    );
    lines.push(truncateToWidth(theme.fg("dim", `  $ ${t.command}`), width));
    lines.push(border);

    const viewport = this.viewportHeight();
    const rawLines = sanitize(outputText(t) || "(no output)").split("\n");
    const maxOffset = Math.max(0, rawLines.length - viewport);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const end = rawLines.length - this.scrollOffset;
    const visible = rawLines.slice(Math.max(0, end - viewport), end);
    for (const line of visible) lines.push(truncateToWidth(line, width));
    // Pad to fixed height so overlay height stays stable.
    while (lines.length < 4 + viewport) lines.push("");

    if (this.scrollOffset > 0) {
      lines[lines.length - 1] = truncateToWidth(
        theme.fg("dim", `... ${this.scrollOffset} lines below · ↓/pgdn`),
        width,
      );
    }

    lines.push(border);
    lines.push(truncateToWidth(theme.fg("dim", `  esc/ctrl-c back · x kill · ↑/↓ scroll · pgup/pgdn page`), width));
    lines.push(border);
    return lines;
  }

  invalidate(): void {}
}
