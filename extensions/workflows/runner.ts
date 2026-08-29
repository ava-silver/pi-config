/**
 * Workflow subagent runner.
 *
 * Each `agent()` call in a workflow script becomes one isolated in-process
 * AgentSession created here: in-memory session, normal trust-aware resources
 * and extensions, recursive orchestration/user-prompt tools denied, and an
 * optional one-shot `structured_output` tool when a schema is supplied.
 *
 * `runAgent()` never throws: every failure mode (session creation, provider
 * errors, aborts, missing structured output) settles into an `AgentOutcome`.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import { emptyUsage, type AgentUsage, type TranscriptEntry } from "./model.ts";
import {
  buildWorkflowAgentPrompt,
  STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { safeStringify, truncateUtf8 } from "./serialization.ts";

const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;
export const FIRST_RESPONSE_TIMEOUT_MS = 45_000;
const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1024;
const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 200;

export type WorkflowModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type AgentMessage = AgentSession["messages"][number];
function isAssistantMessage(
  message: AgentMessage | undefined,
): message is Extract<AgentMessage, { role: "assistant" }> {
  return message?.role === "assistant";
}
type ToolTimingEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_end" }>;

export interface ToolExecutionTiming {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentOutcome {
  ok: boolean;
  /** Final assistant text (may be empty when only structured output was produced). */
  output: string;
  /** Captured structured_output payload when a schema was supplied. */
  structured?: unknown;
  error?: string;
  aborted: boolean;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface AgentProgress {
  preview: string;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface RunAgentOptions {
  prompt: string;
  schema?: unknown;
  model?: WorkflowModel;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  modelRegistry: ExtensionContext["modelRegistry"];
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  /** Test-only override for the per-tool execution timeout. */
  toolCallTimeoutMs?: number;
  /** Test-only override for the first assistant response-event timeout. */
  firstResponseTimeoutMs?: number;
}

/** Build a fresh extension runtime for each concurrent workflow child. */
export function createWorkflowResources(cwd: string, variant: "plain" | "structured", projectTrusted: boolean) {
  return createChildResources({
    cwd,
    projectTrusted,
    ...(variant === "structured" ? { appendSystemPrompt: [STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION] } : {}),
  });
}

interface WorkflowToolSession {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
  subscribe(listener: AgentSessionEventListener): () => void;
}

/** Guard current tools and tools registered by extensions at later agent starts. */
export function guardWorkflowChildTools(session: WorkflowToolSession, timeoutMs?: number) {
  const guard = createToolCallTimeoutGuard(timeoutMs);
  guard.apply(session);
  return session.subscribe((event) => {
    if (event.type === "agent_start") guard.apply(session);
  });
}

function isJsonSchema(value: unknown): value is TSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const validate = (current: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 24) return false;
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return true;
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (Array.isArray(current)) {
      return current.every((item) => validate(item, depth + 1));
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    return Object.keys(current).every((key) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return false;
      }
      return validate((current as Record<string, unknown>)[key], depth + 1);
    });
  };
  return validate(value, 0);
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
function jsonSchemaToTypebox(schema: unknown): TSchema {
  if (!isJsonSchema(schema)) {
    throw new Error("structured output schema must be a bounded JSON object");
  }
  return Type.Unsafe(schema);
}

/**
 * One-shot terminating tool injected when a schema is supplied: the subagent
 * calls it as its final action and we capture the validated object.
 */
function makeStructuredOutputTool(schema: unknown, capture: (value: unknown) => void): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    parameters: jsonSchemaToTypebox(schema),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: "Recorded structured result." }],
        details: params,
        terminate: true,
      };
    },
  });
}

function finalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isAssistantMessage(msg)) continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string {
  return safeStringify(value, {
    maxBytes: TRANSCRIPT_ENTRY_MAX_BYTES,
    maxDepth: 12,
    maxNodes: 2_000,
  });
}

/** Record lifecycle timings without inferring completion from message timestamps. */
export function recordToolExecutionTiming(
  timings: Map<string, ToolExecutionTiming>,
  event: ToolTimingEvent,
  observedAt = Date.now(),
) {
  const previous = timings.get(event.toolCallId);
  if (event.type === "tool_execution_start") {
    if (previous?.startedAt !== undefined) return;
    timings.set(event.toolCallId, { ...previous, startedAt: observedAt });
    return;
  }
  if (previous?.finishedAt !== undefined) return;
  const durationMs = previous?.startedAt === undefined ? undefined : Math.max(0, observedAt - previous.startedAt);
  timings.set(event.toolCallId, {
    ...previous,
    finishedAt: observedAt,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function toolMetadata(toolCallId: string, timings: ReadonlyMap<string, ToolExecutionTiming>) {
  const timing = timings.get(toolCallId);
  return {
    toolCallId: truncateUtf8(toolCallId, 1024),
    ...(timing?.startedAt === undefined ? {} : { startedAt: timing.startedAt }),
    ...(timing?.finishedAt === undefined ? {} : { finishedAt: timing.finishedAt }),
    ...(timing?.durationMs === undefined ? {} : { durationMs: timing.durationMs }),
  };
}

/** Convert pi messages into a compact, serializable transcript for the UI. */
export function transcriptFromMessages(
  messages: AgentMessage[],
  toolTimings: ReadonlyMap<string, ToolExecutionTiming> = new Map(),
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`)).join("\n");
      if (text.trim()) {
        entries.push({ role: "user", text, timestamp: message.timestamp });
      }
      continue;
    }

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) {
          entries.push({
            role: "assistant",
            text: part.text,
            timestamp: message.timestamp,
          });
        } else if (part.type === "thinking" && part.thinking.trim()) {
          entries.push({
            role: "thinking",
            text: part.thinking,
            timestamp: message.timestamp,
          });
        } else if (part.type === "toolCall") {
          entries.push({
            role: "tool",
            name: part.name,
            text: safeJson(part.arguments),
            timestamp: message.timestamp,
            ...toolMetadata(part.id, toolTimings),
          });
        }
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
      .join("\n");
    entries.push({
      role: "toolResult",
      name: message.toolName,
      text,
      isError: message.isError,
      timestamp: message.timestamp,
      ...toolMetadata(message.toolCallId, toolTimings),
    });
  }
  const firstEntry = entries[0];
  const selected =
    entries.length <= TRANSCRIPT_MAX_ENTRIES || !firstEntry
      ? entries
      : [firstEntry, ...entries.slice(-(TRANSCRIPT_MAX_ENTRIES - 1))];
  const bounded: TranscriptEntry[] = [];
  let totalBytes = 0;
  for (const entry of selected) {
    const remaining = TRANSCRIPT_TOTAL_MAX_BYTES - totalBytes;
    if (remaining <= 0) break;
    const text = truncateUtf8(entry.text, Math.min(TRANSCRIPT_ENTRY_MAX_BYTES, remaining));
    totalBytes += Buffer.byteLength(text, "utf8");
    bounded.push({
      ...entry,
      text: text === entry.text ? text : `${text}\n[transcript entry truncated]`,
    });
  }
  if (bounded.length < entries.length) {
    bounded.push({
      role: "toolResult",
      name: "transcript",
      text: `[transcript truncated: retained ${bounded.length} of ${entries.length} entries]`,
    });
  }
  return bounded;
}

function computeUsage(messages: AgentMessage[]): AgentUsage {
  const usage = emptyUsage();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    usage.turns++;
    const u = msg.usage;
    if (!u) continue;
    usage.input += u.input || 0;
    usage.output += u.output || 0;
    usage.cacheRead += u.cacheRead || 0;
    usage.cacheWrite += u.cacheWrite || 0;
    usage.cost += u.cost?.total || 0;
  }
  return usage;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 16 * 1024);
}

function modelMetadata(model: string | undefined, contextWindow: number | undefined) {
  return {
    ...(model === undefined ? {} : { model }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

function formatTimeout(timeoutMs: number) {
  return timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} seconds` : `${timeoutMs} ms`;
}

/** Abort a provider call that opens but never emits its first assistant event. */
export function createFirstResponseWatchdog(
  onTimeout: () => Promise<unknown>,
  options: { timeoutMs?: number; model?: string } = {},
) {
  const timeoutMs = options.timeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      const model = options.model ? ` for ${options.model}` : "";
      reject(
        new Error(
          `Agent received no assistant response event${model} within ${formatTimeout(timeoutMs)}; the provider request may be stalled. Retry the workflow.`,
        ),
      );
      void onTimeout().catch(() => {});
    }, timeoutMs);
    timer.unref?.();
  });

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    markResponse: cancel,
    async waitFor<T>(operation: Promise<T>) {
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        cancel();
      }
    },
  };
}

function isAssistantResponseEvent(event: AgentSessionEvent) {
  return (
    (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
    event.message.role === "assistant"
  );
}

interface WorkflowChildAgent {
  session: AgentSession;
  unsubscribeToolTimeout: () => void;
  structured: () => unknown;
}

interface AgentRunState {
  usage: AgentUsage;
  modelId: string | undefined;
  contextWindow: number | undefined;
  stopReason?: string;
  errorMessage?: string;
  aborted: boolean;
  abortPromise?: Promise<void>;
  toolTimings: Map<string, ToolExecutionTiming>;
}

async function createWorkflowChildAgent(options: RunAgentOptions): Promise<WorkflowChildAgent> {
  let structured: unknown;
  const customTools =
    options.schema === undefined
      ? undefined
      : [
          makeStructuredOutputTool(options.schema, (value) => {
            structured = value;
          }),
        ];
  const { session } = await createAgentSession({
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    resourceLoader: options.loader,
    settingsManager: options.settingsManager,
    sessionManager: SessionManager.inMemory(options.cwd),
    ...(customTools ? { customTools } : {}),
    ...childToolPolicy(),
  });
  try {
    await bindChildSessionExtensions(session);
    return {
      session,
      unsubscribeToolTimeout: guardWorkflowChildTools(session, options.toolCallTimeoutMs),
      structured: () => structured,
    };
  } catch (error) {
    await shutdownAndDisposeChildSession(session);
    throw error;
  }
}

function creationFailure(options: RunAgentOptions, error: unknown): AgentOutcome {
  return {
    ok: false,
    output: "",
    error: `Failed to create agent session: ${errorText(error)}`,
    aborted: false,
    usage: emptyUsage(),
    ...modelMetadata(options.model?.id, options.model?.contextWindow),
    transcript: [],
  };
}

function createAgentRunState(session: AgentSession, options: RunAgentOptions): AgentRunState {
  return {
    usage: emptyUsage(),
    modelId: session.model?.id ?? options.model?.id,
    contextWindow: session.model?.contextWindow,
    aborted: false,
    toolTimings: new Map(),
  };
}

function syncAgentState(session: AgentSession, state: AgentRunState, options: RunAgentOptions) {
  const messages = session.messages;
  state.usage = computeUsage(messages);
  const sessionModel = session.model;
  state.modelId = sessionModel?.id ?? state.modelId;
  state.contextWindow = sessionModel?.contextWindow ?? state.contextWindow;
  const context = session.getContextUsage();
  if (typeof context?.tokens === "number" && Number.isFinite(context.tokens) && context.tokens >= 0) {
    state.usage.contextTokens = context.tokens;
  }
  if (
    typeof context?.contextWindow === "number" &&
    Number.isFinite(context.contextWindow) &&
    context.contextWindow > 0
  ) {
    state.contextWindow = context.contextWindow;
  }
  updateResponseMetadata(messages, sessionModel, state, options.modelRegistry);
}

function updateResponseMetadata(
  messages: AgentMessage[],
  sessionModel: WorkflowModel | undefined,
  state: AgentRunState,
  modelRegistry: ExtensionContext["modelRegistry"],
) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isAssistantMessage(message)) continue;
    const matchesSession =
      !sessionModel || (message.provider === sessionModel.provider && message.model === sessionModel.id);
    const reportedModel = matchesSession
      ? modelRegistry.find(message.provider, message.responseModel ?? message.model)
      : undefined;
    if (reportedModel) {
      state.modelId = reportedModel.id;
      state.contextWindow = reportedModel.contextWindow;
    }
    if (message.stopReason) state.stopReason = message.stopReason;
    if (message.errorMessage) state.errorMessage = message.errorMessage;
    return;
  }
}

function subscribeToAgentProgress(
  session: AgentSession,
  state: AgentRunState,
  options: RunAgentOptions,
  responseMarker: { mark: () => void },
) {
  return session.subscribe((event) => {
    if (isAssistantResponseEvent(event)) responseMarker.mark();
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      recordToolExecutionTiming(state.toolTimings, event);
    } else if (event.type !== "message_end" && event.type !== "compaction_end") {
      return;
    }
    syncAgentState(session, state, options);
    options.onProgress?.({
      preview: finalOutput(session.messages),
      usage: state.usage,
      ...modelMetadata(state.modelId, state.contextWindow),
      transcript: transcriptFromMessages(session.messages, state.toolTimings),
    });
  });
}

function observeAbort(signal: AbortSignal | undefined, session: AgentSession, state: AgentRunState) {
  const onAbort = () => {
    state.aborted = true;
    state.abortPromise ??= session.abort().catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return () => signal?.removeEventListener("abort", onAbort);
}

async function finishAgentRun(
  child: WorkflowChildAgent,
  state: AgentRunState,
  options: RunAgentOptions,
  unsubscribe: () => void,
  stopObservingAbort: () => void,
) {
  stopObservingAbort();
  if (state.abortPromise) await state.abortPromise;
  unsubscribe();
  child.unsubscribeToolTimeout();
  syncAgentState(child.session, state, options);
  const output = truncateUtf8(finalOutput(child.session.messages), AGENT_OUTPUT_MAX_BYTES);
  const transcript = transcriptFromMessages(child.session.messages, state.toolTimings);
  await shutdownAndDisposeChildSession(child.session);
  return { output, transcript };
}

function agentOutcome(
  options: RunAgentOptions,
  child: WorkflowChildAgent,
  state: AgentRunState,
  result: { output: string; transcript: TranscriptEntry[] },
): AgentOutcome {
  const structured = child.structured();
  const common = {
    output: result.output,
    ...(structured === undefined ? {} : { structured }),
    usage: state.usage,
    ...modelMetadata(state.modelId, state.contextWindow),
    transcript: result.transcript,
  };
  if (state.aborted || state.stopReason === "aborted") {
    return { ok: false, ...common, error: "Agent was aborted", aborted: true };
  }
  if (state.stopReason === "error" || state.errorMessage !== undefined) {
    return { ok: false, ...common, error: state.errorMessage ?? "Agent failed", aborted: false };
  }
  if (options.schema !== undefined && structured === undefined) {
    return {
      ok: false,
      ...common,
      error: "Agent finished without calling structured_output; no structured result matching the schema was produced.",
      aborted: false,
    };
  }
  return { ok: true, ...common, aborted: false };
}

export async function runAgent(options: RunAgentOptions): Promise<AgentOutcome> {
  let child: WorkflowChildAgent;
  try {
    child = await createWorkflowChildAgent(options);
  } catch (error) {
    return creationFailure(options, error);
  }
  const state = createAgentRunState(child.session, options);
  const responseMarker = { mark: () => {} };
  const unsubscribe = subscribeToAgentProgress(child.session, state, options, responseMarker);
  const stopObservingAbort = observeAbort(options.signal, child.session, state);
  try {
    if (!state.aborted) {
      const watchdog = createFirstResponseWatchdog(() => child.session.abort(), {
        ...(options.firstResponseTimeoutMs === undefined ? {} : { timeoutMs: options.firstResponseTimeoutMs }),
        ...(state.modelId === undefined ? {} : { model: state.modelId }),
      });
      responseMarker.mark = watchdog.markResponse;
      await watchdog.waitFor(child.session.prompt(buildWorkflowAgentPrompt(options.prompt)));
    }
  } catch (error) {
    state.errorMessage ??= errorText(error);
    state.stopReason ??= "error";
  }
  const result = await finishAgentRun(child, state, options, unsubscribe, stopObservingAbort);
  return agentOutcome(options, child, state, result);
}
