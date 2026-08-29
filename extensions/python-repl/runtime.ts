import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { killProcessTree } from "../shared/process-tree.ts";

const RUNNER_PATH = fileURLToPath(new URL("runner.py", import.meta.url));
const COMMAND_OUTPUT_LIMIT = 64 * 1024;

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
}

interface RunnerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRunnerResponse(line: string): RunnerResponse {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.ok !== "boolean") {
    throw new Error("Python REPL returned an invalid response.");
  }
  return {
    id: value.id,
    ok: value.ok,
    ...(value.value !== undefined ? { value: value.value } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function parseExecutionResult(value: unknown): ExecutionResult {
  if (
    !isRecord(value) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    !(typeof value.result === "string" || value.result === null) ||
    !(typeof value.error === "string" || value.error === null)
  ) {
    throw new Error("Python REPL returned an invalid execution result.");
  }
  return {
    stdout: value.stdout,
    stderr: value.stderr,
    result: value.result,
    error: value.error,
  };
}

async function runCommand(
  command: string,
  args: string[],
  opts: { signal: AbortSignal | undefined; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(command, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-COMMAND_OUTPUT_LIMIT);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const stop = () => {
      if (proc.pid !== undefined) killProcessTree(proc.pid);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const abort = () => stop();
    opts.signal?.addEventListener("abort", abort, { once: true });

    proc.on("error", (error) => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) reject(new Error("Python operation cancelled."));
      else if (timedOut) reject(new Error(`Python operation timed out after ${opts.timeoutMs / 1000} seconds.`));
      else if (code !== 0) reject(new Error(stderr.trim() || `${command} exited with code ${code}.`));
      else resolve({ stdout, stderr });
    });
  });
}

export class PythonRepl {
  private tempDir: string | undefined;
  private proc: childProcess.ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private queue: Promise<void> = Promise.resolve();
  private runnerStderr = "";
  private closed = false;

  get environmentPath(): string | undefined {
    return this.tempDir;
  }

  private pythonPath(): string {
    if (!this.tempDir) throw new Error("Python environment is not initialized.");
    return process.platform === "win32"
      ? path.join(this.tempDir, "Scripts", "python.exe")
      : path.join(this.tempDir, "bin", "python");
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Python REPL is closed.");
  }

  private async ensureEnvironment(signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    if (this.tempDir) return;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-python-repl-"));
    await fs.chmod(tempDir, 0o700);
    try {
      await runCommand("python3", ["-m", "venv", tempDir], { signal, timeoutMs: 60_000 });
      this.assertOpen();
      this.tempDir = tempDir;
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  private startRunner(): void {
    if (this.proc) return;
    const proc = childProcess.spawn(this.pythonPath(), ["-u", RUNNER_PATH], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.runnerStderr = "";
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on("line", (line) => {
      let response: RunnerResponse;
      try {
        response = parseRunnerResponse(line);
      } catch (error) {
        this.failRunner(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error ?? "Python REPL request failed."));
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      this.runnerStderr = (this.runnerStderr + chunk.toString()).slice(-COMMAND_OUTPUT_LIMIT);
    });
    proc.on("error", (error) => this.failRunner(error));
    proc.on("close", (code) => {
      if (this.proc !== proc) return;
      const detail = this.runnerStderr.trim();
      this.failRunner(new Error(detail || `Python REPL exited with code ${code}.`));
    });
  }

  private failRunner(error: Error): void {
    const proc = this.proc;
    this.proc = undefined;
    if (proc?.pid !== undefined) killProcessTree(proc.pid);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private async request(
    action: "execute" | "clear",
    data: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.assertOpen();
    this.startRunner();
    const proc = this.proc;
    if (!proc) throw new Error("Python REPL failed to start.");
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.failRunner(new Error("Python execution cancelled; REPL state was cleared."));
      };
      if (signal?.aborted) {
        abort();
        reject(new Error("Python execution cancelled; REPL state was cleared."));
        return;
      }
      const finishResolve = (value: unknown) => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const finishReject = (error: Error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      };
      this.pending.set(id, { resolve: finishResolve, reject: finishReject });
      signal?.addEventListener("abort", abort, { once: true });
      proc.stdin.write(`${JSON.stringify({ id, action, ...data })}\n`, (error) => {
        if (error) this.failRunner(error);
      });
    });
  }

  execute(code: string, signal?: AbortSignal): Promise<ExecutionResult> {
    return this.exclusive(async () => {
      this.assertOpen();
      await this.ensureEnvironment(signal);
      return parseExecutionResult(await this.request("execute", { code }, signal));
    });
  }

  clear(signal?: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen();
      if (!this.tempDir) return;
      await this.request("clear", {}, signal);
    });
  }

  install(packages: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    return this.exclusive(async () => {
      this.assertOpen();
      await this.ensureEnvironment(signal);
      return runCommand(this.pythonPath(), ["-m", "pip", "install", "--", ...packages], {
        signal,
        timeoutMs: 120_000,
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.proc) this.failRunner(new Error("Python REPL closed."));
    await this.exclusive(async () => {
      if (this.tempDir) await fs.rm(this.tempDir, { recursive: true, force: true });
      this.tempDir = undefined;
    });
  }
}
