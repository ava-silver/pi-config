import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { safeStringify, toSerializable } from "./serialization.ts";

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ARGS_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_AGENT_MESSAGE_BYTES = 512 * 1024;
const MAX_AGENT_REQUESTS = 32;

export interface SandboxAgentOptions {
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
}

export interface SandboxAgentResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  error?: string;
}

export interface RunWorkflowSandboxOptions {
  source: string;
  args: unknown;
  cwd: string;
  signal: AbortSignal;
  onAgent: (prompt: string, options: SandboxAgentOptions, signal: AbortSignal) => Promise<SandboxAgentResult>;
  onPhase: (title: string) => void;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function terminateChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1_000);
  force.unref?.();
}

function sanitizeAgentOptions(value: unknown): SandboxAgentOptions {
  if (!isRecord(value)) return {};
  return {
    ...(value.label !== undefined ? { label: value.label } : {}),
    ...(value.phase !== undefined ? { phase: value.phase } : {}),
    ...(value.schema !== undefined ? { schema: value.schema } : {}),
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.effort !== undefined ? { effort: value.effort } : {}),
  };
}

interface SandboxMessageContext {
  token: string;
  child: ChildProcess;
  options: RunWorkflowSandboxOptions;
  requestIds: Set<number>;
  activeAgentRequests: Map<number, AbortController>;
  finish: (error?: Error, value?: unknown) => void;
  isFinished: () => boolean;
  acceptRequest: (id: number) => boolean;
}

interface AgentRequest {
  id: number;
  prompt: string;
  options: Record<string, unknown>;
}

function parseAgentRequest(payloadJson: string): AgentRequest | undefined {
  const payload: unknown = JSON.parse(payloadJson);
  if (
    !isRecord(payload) ||
    !Number.isSafeInteger(payload.id) ||
    typeof payload.id !== "number" ||
    payload.id < 1 ||
    typeof payload.prompt !== "string" ||
    payload.prompt.length > 100_000 ||
    !isRecord(payload.options)
  ) {
    return undefined;
  }
  return { id: payload.id, prompt: payload.prompt, options: payload.options };
}

function sendAgentResult(context: SandboxMessageContext, id: number, result: SandboxAgentResult) {
  if (!context.activeAgentRequests.delete(id) || context.isFinished() || !context.child.connected) return;
  const normalized = toSerializable(result, { maxDepth: 16, maxNodes: 10_000, maxStringBytes: 128 * 1024 });
  let resultJson = JSON.stringify(normalized);
  if (byteLength(resultJson) > MAX_AGENT_MESSAGE_BYTES) {
    resultJson = JSON.stringify({
      ok: false,
      output: "",
      error: "Agent result exceeded the workflow IPC output limit",
    });
  }
  context.child.send({ token: context.token, kind: "agentResult", id, resultJson });
}

function handlePhaseMessage(raw: Record<string, unknown>, context: SandboxMessageContext) {
  if (typeof raw.payloadJson !== "string" || raw.payloadJson.length > 4096) {
    context.finish(new Error("Workflow sandbox sent an invalid phase update"));
    return;
  }
  try {
    const payload: unknown = JSON.parse(raw.payloadJson);
    if (!isRecord(payload) || typeof payload.title !== "string") throw new Error("invalid title");
    context.options.onPhase(payload.title.slice(0, 160));
  } catch {
    context.finish(new Error("Workflow sandbox sent an invalid phase update"));
  }
}

function handleAgentMessage(raw: Record<string, unknown>, context: SandboxMessageContext) {
  if (typeof raw.payloadJson !== "string" || byteLength(raw.payloadJson) > MAX_AGENT_MESSAGE_BYTES) {
    context.finish(new Error("Workflow sandbox sent an oversized agent request"));
    return;
  }
  let request: AgentRequest | undefined;
  try {
    request = parseAgentRequest(raw.payloadJson);
  } catch {
    context.finish(new Error("Workflow sandbox sent malformed agent JSON"));
    return;
  }
  if (!request) {
    context.finish(new Error("Workflow sandbox sent an invalid agent request"));
    return;
  }
  if (!context.acceptRequest(request.id)) {
    context.finish(new Error("Workflow sandbox exceeded its agent request budget"));
    return;
  }
  const abortController = new AbortController();
  context.activeAgentRequests.set(request.id, abortController);
  void context.options
    .onAgent(request.prompt, sanitizeAgentOptions(request.options), abortController.signal)
    .then((result) => sendAgentResult(context, request.id, result))
    .catch((error) => sendAgentResult(context, request.id, { ok: false, output: "", error: errorText(error) }));
}

function handleResultMessage(raw: Record<string, unknown>, context: SandboxMessageContext) {
  if (typeof raw.resultJson !== "string" || byteLength(raw.resultJson) > MAX_RESULT_BYTES) {
    context.finish(new Error("Workflow result exceeded the IPC limit"));
    return;
  }
  try {
    const normalized = toSerializable(JSON.parse(raw.resultJson));
    context.finish(undefined, JSON.parse(JSON.stringify(normalized)));
  } catch (error) {
    context.finish(new Error(`Workflow returned invalid JSON: ${errorText(error)}`));
  }
}

function handleSandboxMessage(raw: unknown, context: SandboxMessageContext) {
  if (!isRecord(raw) || raw.token !== context.token || typeof raw.kind !== "string") {
    context.finish(new Error("Workflow sandbox sent an invalid IPC message"));
    return;
  }
  switch (raw.kind) {
    case "phase":
      handlePhaseMessage(raw, context);
      return;
    case "agent":
      handleAgentMessage(raw, context);
      return;
    case "result":
      handleResultMessage(raw, context);
      return;
    case "error":
      if (typeof raw.error === "string") {
        context.finish(new Error(raw.error.slice(0, 16 * 1024)));
        return;
      }
  }
  context.finish(new Error("Workflow sandbox sent an unknown IPC message"));
}

/**
 * Execute orchestration code in a separate child process using the current runtime.
 * The child exposes only the narrow agent/phase IPC protocol and is always
 * terminated on completion, cancellation, or protocol failure. The workflow
 * itself and its agent requests have no wall-clock deadline. Active requests
 * are aborted only when the workflow is cancelled or the sandbox is cleaned up.
 */
export function runWorkflowSandbox(options: RunWorkflowSandboxOptions) {
  if (byteLength(options.source) > MAX_SOURCE_BYTES) {
    return Promise.reject(new Error(`Workflow script exceeds the ${MAX_SOURCE_BYTES} byte limit`));
  }

  const argsJson = safeStringify(
    { defined: options.args !== undefined, value: options.args },
    { maxBytes: MAX_ARGS_BYTES, maxDepth: 16, maxNodes: 10_000 },
  );
  if (byteLength(argsJson) > MAX_ARGS_BYTES) {
    return Promise.reject(new Error("Workflow args exceed the IPC limit"));
  }

  return new Promise<unknown>((resolve, reject) => {
    const workerPath = fileURLToPath(new URL("./sandbox-child.cjs", import.meta.url));
    const child = spawn(process.execPath, ["--max-old-space-size=128", "--stack-size=2048", workerPath], {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const token = randomBytes(24).toString("hex");
    const requestIds = new Set<number>();
    const activeAgentRequests = new Map<number, AbortController>();
    let requestCount = 0;
    let finished = false;

    const cleanup = () => {
      for (const abortController of activeAgentRequests.values()) {
        abortController.abort(new Error("Workflow stopped"));
      }
      activeAgentRequests.clear();
      options.signal.removeEventListener("abort", onAbort);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      terminateChild(child);
    };
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("Workflow was aborted"));

    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }

    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      if (!finished) {
        finish(new Error(`Workflow sandbox exited before completion (${exitSignal ?? code ?? "unknown"})`));
      }
    });
    child.on("message", (raw: unknown) => {
      handleSandboxMessage(raw, {
        token,
        child,
        options,
        requestIds,
        activeAgentRequests,
        finish,
        isFinished: () => finished,
        acceptRequest: (id) => {
          if (requestIds.has(id) || ++requestCount > MAX_AGENT_REQUESTS) return false;
          requestIds.add(id);
          return true;
        },
      });
    });

    child.send(
      {
        kind: "init",
        token,
        source: options.source,
        argsJson,
      },
      (error) => {
        if (error) finish(error);
      },
    );
  });
}
