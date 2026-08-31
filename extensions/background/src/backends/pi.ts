/**
 * pi backend -- real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts + shared/child-session.ts):
 * - real session files visible in /resume, child resources loaded per-cwd
 *   with trust gating, and the child tool denylist;
 * - `session.subscribe()` events translated to normalized SubagentEvents;
 * - send() steers a streaming run or starts a fresh prompt() when idle;
 * - interrupt clears the queue and aborts; closing the session scope emits
 *   the child session_shutdown hook and disposes the session.
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import { Type } from "typebox";
import type { SpawnTask, SubagentEvent, SubagentMeta, SubagentSession, TranscriptPart } from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  resolveChildModel,
  shutdownAndDisposeChildSession,
  waitForChildSessionOperation,
} from "../../../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../../../shared/tool-call-timeout.ts";

type ThinkingLevel = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]>;

// --- Event translation ----------------------------------------------------------

function messageRole(msg: unknown): Message["role"] | undefined {
  const role = (msg as { role?: string } | undefined)?.role;
  if (role === "user" || role === "assistant" || role === "toolResult") return role;
  return undefined;
}

function lastAssistantMessage(session: AgentSession): AssistantMessage | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

/** Final assistant text output (last assistant message with text), v1 semantics. */
function finalOutput(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) !== "assistant") continue;
    const text = (msg as AssistantMessage).content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The argument key that best summarizes a call for known tool types. */
const TOOL_SUMMARY_KEY = {
  bash: "command",
  read: "path",
  write: "path",
  edit: "path",
  fetch_content: "url",
  web_search: "query",
  ffgrep: "pattern",
  fffind: "pattern",
  source_check: "claim",
  subagent_spawn: "name",
  subagent_check: "id",
  subagent_wait: "ids",
  subagent_cancel: "ids",
  subagent_list: null,
  workflow: null,
  ask_user: "question",
  ask_parent: "question",
} satisfies Record<string, string | null>;

/**
 * Human-readable one-line preview of tool arguments. Extracts the most
 * meaningful argument for known tools; falls back to the first string value
 * found, then raw JSON.
 */
function toolCallPreview(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return safeJson(args);
  const obj = args as Record<string, unknown>;

  const key = Object.hasOwn(TOOL_SUMMARY_KEY, toolName)
    ? TOOL_SUMMARY_KEY[toolName as keyof typeof TOOL_SUMMARY_KEY]
    : undefined;

  if (key === null) return undefined; // known, no meaningful args to show

  const target = key !== undefined ? obj[key] : undefined;
  if (typeof target === "string") {
    const first = target.split("\n")[0]?.trim() ?? "";
    return first.slice(0, 300) || undefined;
  }
  if (Array.isArray(target)) {
    const items = (target as unknown[]).filter((v): v is string => typeof v === "string");
    return items.join(", ").slice(0, 300) || undefined;
  }

  // Unknown tool: use the first non-empty string value as a best-effort preview.
  for (const val of Object.values(obj)) {
    if (typeof val === "string" && val.trim()) {
      return (val.split("\n")[0] ?? "").trim().slice(0, 300);
    }
  }

  return safeJson(args);
}

/** First non-empty line of a tool result-ish value (v1 liveToolPreview). */
function toolPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
  }
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = record.text.split("\n").find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

function assistantParts(msg: AssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: part.redacted ? "" : part.thinking,
        ...(part.redacted === undefined ? {} : { redacted: part.redacted }),
      });
    } else if (part.type === "toolCall") {
      const argsPreview = toolCallPreview(part.name, part.arguments);
      parts.push({
        type: "toolCall",
        toolId: part.id,
        name: part.name,
        ...(argsPreview === undefined ? {} : { argsPreview }),
      });
    }
  }
  return parts;
}

function userText(msg: Message): string {
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

// --- The session ------------------------------------------------------------------

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}

interface PiSessionState {
  closed: boolean;
  runError: string | undefined;
  settled: boolean;
  questionCounter: number;
}

type Emit = (event: SubagentEvent) => void;
type PendingAnswer = {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
};

function createAskParentTool(state: PiSessionState, emit: Emit, pendingAnswers: Map<string, PendingAnswer>) {
  return defineTool({
    name: "ask_parent",
    label: "Ask Parent",
    description:
      "Ask the parent agent for clarification, missing context, or a decision, then wait for its response. Use your judgment: resolve meaningful ambiguities rather than guessing.",
    promptSnippet: "Ask the parent agent for clarification, missing context, or a decision, then wait for its answer",
    promptGuidelines: [
      "Ask the parent when clarification, missing context, or a decision could improve the result. Proceed independently for routine details, but prefer resolving meaningful ambiguities over guessing.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "The specific question the parent agent should answer",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      if (state.closed) throw new Error("The parent session is no longer available.");
      const id = `q-${++state.questionCounter}`;
      const answer = await new Promise<string>((resolve, reject) => {
        const abort = () => {
          if (!pendingAnswers.delete(id)) return;
          emit({ _tag: "QuestionClosed", questionId: id });
          reject(new Error("Parent question was cancelled."));
        };
        signal?.addEventListener("abort", abort, { once: true });
        pendingAnswers.set(id, {
          resolve,
          reject,
          removeAbortListener: () => signal?.removeEventListener("abort", abort),
        });
        if (signal?.aborted) {
          abort();
          return;
        }
        emit({
          _tag: "QuestionAsked",
          question: { id, text: params.question },
        });
      });
      return {
        content: [{ type: "text", text: `Parent response: ${answer}` }],
        details: { question: params.question, answer },
      };
    },
  });
}

interface ChildSessionSetup {
  task: SpawnTask;
  model: Model<any> | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  askParentTool: ReturnType<typeof defineTool>;
  sessionFilePath?: string;
}

function createChildSession(setup: ChildSessionSetup) {
  return Effect.tryPromise({
    try: async () => {
      const { loader, settingsManager } = await createChildResources({
        cwd: setup.task.cwd,
        projectTrusted: setup.task.parent.projectTrusted,
        excludedExtensionBasenames: ["google-style.ts"],
      });
      const { session } = await createAgentSession({
        cwd: setup.task.cwd,
        sessionManager: setup.sessionFilePath
          ? SessionManager.open(setup.sessionFilePath, undefined, setup.task.cwd)
          : SessionManager.create(setup.task.cwd),
        settingsManager,
        resourceLoader: loader,
        ...(setup.model === undefined ? {} : { model: setup.model }),
        ...(setup.thinkingLevel === undefined ? {} : { thinkingLevel: setup.thinkingLevel }),
        customTools: [setup.askParentTool],
        ...childToolPolicy(),
      });
      try {
        await bindChildSessionExtensions(session);
      } catch (error) {
        await shutdownAndDisposeChildSession(session);
        throw error;
      }
      return session;
    },
    catch: (error) => new SpawnError({ message: boundedError(error) }),
  });
}

interface SessionControl {
  currentMeta(): SubagentMeta;
  handleEvent(event: AgentSessionEvent): void;
  startRun(text: string): void;
}

interface SessionControlSetup {
  session: AgentSession;
  registry: NonNullable<SpawnTask["parent"]["modelRegistry"]>;
  state: PiSessionState;
  emit: Emit;
  toolTimeout: ReturnType<typeof createToolCallTimeoutGuard>;
}

function createSessionControl(setup: SessionControlSetup): SessionControl {
  const { session, registry, state, emit, toolTimeout } = setup;
  const activeModel = (): Model<any> | undefined => {
    const sessionModel = session.model;
    const last = lastAssistantMessage(session);
    if (!last || (sessionModel && (last.provider !== sessionModel.provider || last.model !== sessionModel.id)))
      return sessionModel;
    return registry.find(last.provider, last.responseModel ?? last.model) ?? sessionModel;
  };
  const currentMeta = (): SubagentMeta => {
    const model = activeModel();
    return {
      ...(model ? { modelLabel: `${model.provider}/${model.id}` } : {}),
      ...(model?.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(session.sessionFile === undefined ? {} : { sessionFilePath: session.sessionFile }),
    };
  };
  const emitUsage = () => {
    const usage = session.getContextUsage();
    const tokens = usage?.tokens;
    const contextWindow = activeModel()?.contextWindow ?? usage?.contextWindow;
    emit({
      _tag: "UsageChanged",
      ...(typeof tokens === "number" ? { tokens } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    });
  };
  const settle = () => {
    if (state.settled) return;
    state.settled = true;
    const last = lastAssistantMessage(session);
    const partialText = finalOutput(session) || undefined;
    if (last?.stopReason === "aborted") {
      emit({
        _tag: "RunSettled",
        outcome: {
          _tag: "Interrupted",
          ...(partialText === undefined ? {} : { partialText }),
        },
      });
      return;
    }
    const errorText =
      state.runError ?? (last?.stopReason === "error" ? (last.errorMessage ?? "Run failed") : undefined);
    if (errorText !== undefined) {
      emit({
        _tag: "RunSettled",
        outcome: {
          _tag: "Failed",
          errorText: boundedError(errorText),
          ...(partialText === undefined ? {} : { partialText }),
        },
      });
      return;
    }
    emit({
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText: finalOutput(session) },
    });
  };
  const handleEvent = (event: AgentSessionEvent) => {
    if (state.closed) return;
    switch (event.type) {
      case "agent_start":
        toolTimeout.apply(session);
        state.settled = false;
        emit({ _tag: "RunStarted" });
        break;
      case "message_update": {
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent.type === "text_delta")
          emit({
            _tag: "AssistantDelta",
            kind: "text",
            delta: streamEvent.delta,
          });
        else if (streamEvent.type === "thinking_delta")
          emit({
            _tag: "AssistantDelta",
            kind: "thinking",
            delta: streamEvent.delta,
          });
        break;
      }
      case "message_end": {
        const role = messageRole(event.message);
        if (role === "user") {
          const text = userText(event.message as Message);
          if (text.trim()) emit({ _tag: "UserMessage", text });
        } else if (role === "assistant") {
          const cost = (event.message as AssistantMessage).usage?.cost?.total;
          emit({
            _tag: "AssistantMessage",
            parts: assistantParts(event.message as AssistantMessage),
            ...(typeof cost === "number" && Number.isFinite(cost) ? { cost } : {}),
          });
          emitUsage();
          emit({ _tag: "MetaChanged", meta: currentMeta() });
        }
        break;
      }
      case "tool_execution_start": {
        const argsPreview = toolCallPreview(event.toolName, event.args);
        emit({
          _tag: "ToolStart",
          toolId: event.toolCallId,
          name: event.toolName,
          ...(argsPreview === undefined ? {} : { argsPreview }),
        });
        break;
      }
      case "tool_execution_update": {
        const outputPreview = toolPreview(event.partialResult);
        emit({
          _tag: "ToolUpdate",
          toolId: event.toolCallId,
          ...(outputPreview === undefined ? {} : { outputPreview }),
        });
        break;
      }
      case "tool_execution_end": {
        const outputPreview = toolPreview(event.result);
        emit({
          _tag: "ToolEnd",
          toolId: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          ...(outputPreview === undefined ? {} : { outputPreview }),
        });
        break;
      }
      case "queue_update":
        emit({
          _tag: "QueueChanged",
          queued: [
            ...event.steering.map((text) => ({ text, kind: "steer" as const })),
            ...event.followUp.map((text) => ({
              text,
              kind: "follow-up" as const,
            })),
          ],
        });
        break;
      case "agent_settled":
        settle();
        break;
    }
  };
  const startRun = (text: string) => {
    state.runError = undefined;
    state.settled = false;
    emit({ _tag: "RunStarted" });
    void session.prompt(text).catch((error) => {
      state.runError = boundedError(error);
      if (!session.isStreaming) settle();
    });
  };
  return { currentMeta, handleEvent, startRun };
}

interface FinalizerSetup {
  session: AgentSession;
  state: PiSessionState;
  pendingAnswers: Map<string, PendingAnswer>;
  unsubscribe: () => void;
  events: Queue.Queue<SubagentEvent, Cause.Done>;
}

function closePiSession(setup: FinalizerSetup) {
  return Effect.promise(async () => {
    setup.state.closed = true;
    for (const pending of setup.pendingAnswers.values()) {
      pending.removeAbortListener();
      pending.reject(new Error("Subagent session closed before the parent answered."));
    }
    setup.pendingAnswers.clear();
    setup.unsubscribe();
    try {
      setup.session.clearQueue();
    } catch {}
    await waitForChildSessionOperation(setup.session.abort(), 5_000);
    await shutdownAndDisposeChildSession(setup.session);
    Queue.endUnsafe(setup.events);
  });
}

function interruptPiSession(session: AgentSession, state: PiSessionState, emit: Emit) {
  return Effect.promise(async () => {
    if (state.closed) return;
    try {
      session.clearQueue();
    } catch {}
    await session.abort().catch(() => undefined);
    while (!state.closed && session.isStreaming) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!state.closed && !state.settled) {
      state.settled = true;
      emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
    }
  });
}

function replayTranscript(session: AgentSession, emit: Emit) {
  for (const message of session.messages) {
    const role = messageRole(message);
    if (role === "user") {
      const text = userText(message as Message);
      if (text.trim()) emit({ _tag: "UserMessage", text });
    } else if (role === "assistant") {
      const assistant = message as AssistantMessage;
      const cost = assistant.usage?.cost?.total;
      emit({
        _tag: "AssistantMessage",
        parts: assistantParts(assistant),
        ...(typeof cost === "number" && Number.isFinite(cost) ? { cost } : {}),
      });
    }
  }
  emit({ _tag: "OutputRestored", finalText: finalOutput(session) });
}

const makePiSession = (
  task: SpawnTask,
  sessionFilePath?: string,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = task.parent.modelRegistry;
    if (!registry)
      return yield* new SpawnError({
        message: "pi backend requires the parent session's model registry.",
      });
    const model = yield* Effect.try({
      try: () => resolveChildModel(registry, task.model, task.parent.inheritedModel),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    const thinkingLevel = (task.reasoningEffort ?? task.parent.inheritedThinkingLevel) as ThinkingLevel | undefined;
    const state: PiSessionState = {
      closed: false,
      runError: undefined,
      settled: false,
      questionCounter: 0,
    };
    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit: Emit = (event) => {
      if (!state.closed) Queue.offerUnsafe(events, event);
    };
    const pendingAnswers = new Map<string, PendingAnswer>();
    const askParentTool = createAskParentTool(state, emit, pendingAnswers);
    const session = yield* createChildSession({
      task,
      model,
      thinkingLevel,
      askParentTool,
      ...(sessionFilePath === undefined ? {} : { sessionFilePath }),
    });
    const toolTimeout = createToolCallTimeoutGuard();
    toolTimeout.apply(session);
    const control = createSessionControl({
      session,
      registry,
      state,
      emit,
      toolTimeout,
    });
    const unsubscribe = session.subscribe((event) => control.handleEvent(event));
    yield* Effect.addFinalizer(() => closePiSession({ session, state, pendingAnswers, unsubscribe, events }));
    yield* Effect.try(() => session.sessionManager.appendSessionInfo(`subagent: ${task.title}`)).pipe(Effect.ignore);
    emit({ _tag: "MetaChanged", meta: control.currentMeta() });
    if (sessionFilePath) replayTranscript(session, emit);
    else control.startRun(task.prompt);
    return {
      meta: Effect.sync(() => control.currentMeta()),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) return new SendError({ message: "Subagent session is closed." });
          if (session.isStreaming)
            return Effect.tryPromise({
              try: () => session.steer(text),
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          control.startRun(text);
          return Effect.void;
        }),
      answer: (questionId, text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          const pending = pendingAnswers.get(questionId);
          if (!pending || state.closed)
            return new SendError({
              message: `Question "${questionId}" is no longer pending.`,
            });
          pendingAnswers.delete(questionId);
          pending.removeAbortListener();
          emit({ _tag: "QuestionClosed", questionId });
          pending.resolve(text);
          return Effect.void;
        }),
      interrupt: interruptPiSession(session, state, emit),
    } satisfies SubagentSession;
  });

export const spawnPiSession = (task: SpawnTask) => makePiSession(task);

export const resumePiSession = (task: SpawnTask, sessionFilePath: string) => makePiSession(task, sessionFilePath);
